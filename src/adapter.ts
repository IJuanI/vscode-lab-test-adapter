import { ChildProcess, fork } from 'child_process';
import { accessSync } from 'fs';
import { format } from 'util';
import * as path from 'path';
// import { parse as parseStackTrace } from 'stack-trace';
import * as stream from 'stream';
import * as vscode from 'vscode';
import {
	TestAdapter,
	// TestDecoration,
	TestEvent,
	TestInfo,
	TestLoadFinishedEvent,
	TestLoadStartedEvent,
	TestRunFinishedEvent,
	TestRunStartedEvent,
	TestSuiteEvent,
	TestSuiteInfo,
} from 'vscode-test-adapter-api';
import { detectNodePath, Log } from 'vscode-test-adapter-util';
import rewire from 'rewire';

interface IDisposable {
	dispose(): void;
}

export class LabAdapter implements TestAdapter, IDisposable {

	private disposables: IDisposable[] = [];

	private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
	private readonly testStatesEmitter = new vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
	private readonly autorunEmitter = new vscode.EventEmitter<void>();

	private config?: LoadedConfig;

	private runningTestProcess: ChildProcess | undefined;

	private primaryExperiments = new Map<string, (TestSuiteInfo | TestInfo)>();

	get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
		return this.testsEmitter.event;
	}

	get testStates(): vscode.Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> {
		return this.testStatesEmitter.event;
	}

	get autorun(): vscode.Event<void> {
		return this.autorunEmitter.event;
	}

	constructor(
		public readonly workspaceFolder: vscode.WorkspaceFolder,
		public readonly channel: vscode.OutputChannel,
		private readonly log: Log
	) {

		this.disposables.push(this.testsEmitter);
		this.disposables.push(this.testStatesEmitter);
		this.disposables.push(this.autorunEmitter);

		this.disposables.push(vscode.workspace.onDidChangeConfiguration(async configChange => {

			this.log.info('Configuration changed');

			if (configChange.affectsConfiguration('labExplorer.cwd', this.workspaceFolder.uri) ||
				configChange.affectsConfiguration('labExplorer.config', this.workspaceFolder.uri) ||
				configChange.affectsConfiguration('labExplorer.env', this.workspaceFolder.uri) ||
				configChange.affectsConfiguration('labExplorer.nodePath', this.workspaceFolder.uri) ||
				configChange.affectsConfiguration('labExplorer.nodeArgv', this.workspaceFolder.uri) ||
				configChange.affectsConfiguration('labExplorer.labPath', this.workspaceFolder.uri)) {

				this.log.info('Sending reload event');
				this.config = undefined;
				this.load();

			} else if (
				configChange.affectsConfiguration('labExplorer.debuggerPort', this.workspaceFolder.uri) ||
				configChange.affectsConfiguration('labExplorer.debuggerConfig', this.workspaceFolder.uri) ||
				configChange.affectsConfiguration('labExplorer.breakOnFirstLine', this.workspaceFolder.uri) ||
				configChange.affectsConfiguration('labExplorer.debuggerSkipFiles', this.workspaceFolder.uri)) {

				this.config = await this.loadConfig();
			}
		}));

		this.disposables.push(vscode.workspace.onDidSaveTextDocument(document => {
			if (!this.config) return;

			const filename = document.uri.fsPath;
			if (this.log.enabled) this.log.info(`${filename} was saved - checking if this affects ${this.workspaceFolder.uri.fsPath}`);

			const absoluteRegex = new RegExp(
				path.join(
					this.config.cwd, `(${this.config.labConfig.paths.join('|')})`).concat(path.sep)
						.replace(/[\/\\]/g, '\\$&')
					.concat(`.*${this.config.labConfig.pattern.source}`));

			if (this.log.enabled) this.log.debug(`Using test file regex: ${absoluteRegex}`);
	
			if (absoluteRegex.test(filename)) {
				if (this.log.enabled) this.log.info(`Sending reload event because ${filename} is a test file`);
				this.load();
				return;
			}
			
			if (filename.startsWith(this.workspaceFolder.uri.fsPath)) {
				this.log.info('Sending autorun event');
				this.autorunEmitter.fire();
			}
		}));
	}

	async load(): Promise<void> {

		if (this.log.enabled) this.log.info(JSON.stringify(process.versions));

		this.testsEmitter.fire(<TestLoadStartedEvent>{ type: 'started' });

		if (!this.config) {
			this.config = await this.loadConfig();
		}
		const config = this.config;
		if (!config) {
			this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', suite: undefined });
			return;
		}

		if (this.log.enabled) this.log.info(`Loading test files of ${this.workspaceFolder.uri.fsPath}`);

		const rootSuite: TestSuiteInfo = {
			type: 'suite',
			id: 'root',
			label: 'Lab',
			children: []
		}

		const suites: (TestSuiteInfo | TestInfo)[] = [];

		let errorMessage;

		try {
		await new Promise<void>(resolve => {
			const args = [config.labPath, config.configFilePath, JSON.stringify(this.log.enabled)];
			// const args = ['', '', config.labPath, config.configFilePath, JSON.stringify(this.log.enabled)];
			const childProcess = fork(
				require.resolve('./worker/loadTests.js'),
				args,
				{
					cwd: config.cwd,
					env: config.env,
					execPath: config.nodePath,
					execArgv: config.nodeArgv,
					stdio: ['pipe', 'pipe', 'pipe', 'ipc']
				}
			);

			// process.argv = args;
			// process.chdir(config.cwd);
			// require('./worker/loadTests.js');

			this.pipeProcess(childProcess);

			// The loader emits one suite per file, in order of running
			// When running in random order, the same file may have multiple suites emitted
			// This way the only thing we need to do is just to replace the name
			// With a shorter one
			childProcess.on('message', (message: string | (TestSuiteInfo | TestInfo)[]) => {
			// process.on('message', (message: string | (TestSuiteInfo | TestInfo)[]) => {

				if (typeof message === 'string') {
					this.log.info(`Worker: ${message}`);
				} else {
					if (this.log.enabled) this.log.info(`Received tests for ${config.cwd} from worker`);
					suites.push(...message);
					resolve();
				}
			});

			childProcess.on('exit', (code, signal) => {
				if (code || signal) {
					errorMessage = `The Lab test loader worker process finished with code ${code} and signal ${signal}`;
				}
				this.log.info('Worker finished');
				resolve();
			});
		});
		} catch (e) {
			console.log('lab load error', e);
		}

		if (this.log.enabled) this.log.info(`Collecting tests for ${this.workspaceFolder.uri.fsPath}`);

		try {

		const collect = (suite: (TestInfo | TestSuiteInfo), primary?: (TestInfo | TestSuiteInfo)) => {
			if (!primary) primary = suite;
			this.primaryExperiments.set(suite.id, primary);
			const s = suite as TestSuiteInfo;
			if (s.children)
				(suite as TestSuiteInfo).children?.forEach(child => collect(child, primary));
		}

		function sortNFill(suite: (TestInfo | TestSuiteInfo)) {
			if (suite.file) suite.file = path.join(config?.cwd || '', suite.file); // Bottlenecked by transfer rate between processes
			const s = suite as TestSuiteInfo;
			if (s.children) {
				s.children = s.children.sort((a, b) => {
					return a.line! - b.line!;
				});
				s.children.forEach((suite) => sortNFill(suite));
			}
			return s;
		}

		this.primaryExperiments.clear();

		// Sort the suites by their filenames
		suites.sort((a, b) => {
			return a.label < b.label ? -1 : 1;
		}).forEach((suite) => {
			collect(suite);
			rootSuite.children.push(sortNFill(suite));
		});

		if (errorMessage) {
			this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', errorMessage });
		} else if (rootSuite.children.length > 0) {
			this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', suite: rootSuite });
		} else {
			this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', suite: undefined });
		}
		} catch (e) {
			if (this.log.enabled) this.log.info(`Lab collect error for ${this.workspaceFolder.uri.fsPath}\n${format(e)}`);
			console.log('lab collect error', e);
		}
		if (this.log.enabled) this.log.info(`Finished loading ${this.workspaceFolder.uri.fsPath}`);
	}

	async run(testsToRun: string[], execArgv: string[] = []): Promise<void> {

		const config = this.config;
		if (!config) return;

		if (this.log.enabled) this.log.info(`Running test(s) ${JSON.stringify(testsToRun)} of ${this.workspaceFolder.uri.fsPath}`);
		
		this.testStatesEmitter.fire(<TestRunStartedEvent>{ type: 'started', tests: testsToRun });
		
		const rootIdx = testsToRun.findIndex(x => 'root');
		if (rootIdx >= 0) testsToRun.splice(rootIdx, 0); // root elements don't count as filters.

		const primaries: string[] = [];
		for (const test of testsToRun) {
			const primary = this.primaryExperiments.get(test);
			if (primary && !primaries.includes(primary.id))
			primaries.push(primary.id);
		}

		if (this.log.enabled) this.log.info(`Principal suite(s) ${JSON.stringify(primaries)}`);

		const args = [config.labPath, config.configFilePath, JSON.stringify(this.log.enabled), JSON.stringify(primaries), JSON.stringify(testsToRun)];
		// const args = ['', '', config.labPath, config.configFilePath, JSON.stringify(this.log.enabled), JSON.stringify(primaries), JSON.stringify(testsToRun)];

		return new Promise<void>((resolve) => {
			try {
			this.runningTestProcess = fork(
				require.resolve('./worker/runTests.js'),
				args,
				{
					cwd: config.cwd,
					env: config.env,
					execPath: config.nodePath,
					execArgv: execArgv.concat(config.nodeArgv),
					stdio: ['pipe', 'pipe', 'pipe', 'ipc']
				}
			);

			// process.argv = args;
			// process.chdir(config.cwd);
			// require('./worker/runTests.js');

			this.pipeProcess(this.runningTestProcess);

			this.runningTestProcess.on('message', (message: string | LabTestEvent) => {
			// process.on('message', (message: string | LabTestEvent) => {

				if (typeof message === 'string') {
					this.log.info(`Worker: ${message}`);

				} else {
					if (this.log.enabled) this.log.info(`Received update for ${message.test} (${message.state})`);

					if (message.failures) {
						// message.decorations = this.createDecorations(message, testfiles);
						delete message.failures;
					}

					this.testStatesEmitter.fire(message);
				}
			});

			this.runningTestProcess.on('exit', () => {
				this.log.info('Worker finished');
				this.runningTestProcess = undefined;
				this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
				resolve();
			});
		} catch (e) {
			console.log('lab runner error', e);
		}
		});
	}

	async debug(testsToRun: string[]): Promise<void> {
		if (!this.config || (testsToRun.length === 0)) {
			return;
		}

		if (this.log.enabled) this.log.info(`Debugging test(s) ${JSON.stringify(testsToRun)} of ${this.workspaceFolder.uri.fsPath}`);

		let currentSession: vscode.DebugSession | undefined;
		// Add a breakpoint on the 1st line of the debugger
		if (this.config.breakOnFirstLine) {
			// const node = this.nodesById.get(testsToRun[0]);
			// if (node && node.file && node.line) {
			// 	const fileURI = vscode.Uri.file(node.file);
			// 	const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(fileURI, new vscode.Position(node.line + 1, 0)));
			// 	vscode.debug.addBreakpoints([breakpoint]);
			// 	const subscription = vscode.debug.onDidTerminateDebugSession((session) => {
			// 		if (currentSession != session) { return; }
			// 		vscode.debug.removeBreakpoints([breakpoint]);
			// 		subscription.dispose();
			// 	});
			// }
		}

		const promise = this.run(testsToRun, [`--inspect-brk=${this.config.debuggerPort}`]);
		if (!promise || !this.runningTestProcess) {
			this.log.error('Starting the worker failed');
			return;
		}

		this.log.info('Starting the debug session');
		await vscode.debug.startDebugging(this.workspaceFolder, this.config.debuggerConfig || {
			name: 'Debug Lab Tests',
			type: 'pwa-node',
			request: 'attach',
			port: this.config.debuggerPort,
			continueOnAttach: true,
			autoAttachChildProcesses: false,
			skipFiles: [
				'<node_internals>/**'
			]
		});

		// workaround for Microsoft/vscode#70125
		await new Promise(resolve => setImmediate(resolve));

		currentSession = vscode.debug.activeDebugSession;
		if (!currentSession) {
			this.log.error('No active debug session - aborting');
			this.cancel();
			return;
		}

		// Kill the process to ensure we're good once the de
		const subscription = vscode.debug.onDidTerminateDebugSession((session) => {
			if (currentSession != session) { return; }
			this.log.info('Debug session ended');
			this.cancel(); // just to be sure
			subscription.dispose();
		});

		return promise;
	}

	cancel(): void {
		if (this.runningTestProcess) {
			this.log.info('Killing running test process');
			this.runningTestProcess.kill();
		}
	}

	dispose(): void {
		this.cancel();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
		this.primaryExperiments.clear();
	}

	private pipeProcess(process: ChildProcess) {
		const customStream = new stream.Writable();
		customStream._write = (data, encoding, callback) => {
			this.channel.append(data.toString());
			callback();
		};
		process.stderr!.pipe(customStream);
		process.stdout!.pipe(customStream);
	}

	private async loadConfig(): Promise<LoadedConfig | undefined> {

		const adapterConfig = vscode.workspace.getConfiguration('labExplorer', this.workspaceFolder.uri);

		const cwd = path.resolve(this.workspaceFolder.uri.fsPath, adapterConfig.get<string>('cwd') || '');

		const configFileName = adapterConfig.get<string>('config') || '.labrc.js';
		const configFilePath = path.resolve(cwd, configFileName);
		if (this.log.enabled) this.log.debug(`Using config file: ${configFilePath}`);

		try {
			accessSync(configFilePath);
		} catch (e) {
			return undefined;
		}

		const processEnv = process.env;
		const configEnv: { [prop: string]: any } = adapterConfig.get('env') || {};
		if (this.log.enabled) this.log.debug(`Using environment variable config: ${JSON.stringify(configEnv)}`);

		const env = { ...processEnv };

		for (const prop in configEnv) {
			const val = configEnv[prop];
			if ((val === undefined) || (val === null)) {
				delete env.prop;
			} else {
				env[prop] = String(val);
			}
		}

		let nodePath: string | undefined = adapterConfig.get<string>('nodePath') || undefined;
		if (nodePath === 'default') {
			nodePath = await detectNodePath();
		}
		if (this.log.enabled) this.log.debug(`Using nodePath: ${nodePath}`);

		let nodeArgv: string[] = adapterConfig.get<string[]>('nodeArgv') || [];
		if (this.log.enabled) this.log.debug(`Using node arguments: ${nodeArgv}`);

		let labPath = adapterConfig.get<string | null>('labPath');
		if (typeof labPath === 'string') {
			labPath = path.resolve(this.workspaceFolder.uri.fsPath, labPath);
		} else {
			labPath = require.resolve('@hapi/lab');
		}

		const labCli = rewire(path.join(labPath, '../cli'));
		labCli.__set__({'internals.rc': require(configFilePath)});
		const args = process.argv;
		process.argv = [];
		const labConfig = labCli.__get__('internals.options')();
		process.argv = args;

		const debuggerPort = adapterConfig.get<number>('debuggerPort') || 9229;

		const debuggerConfig = adapterConfig.get<string>('debuggerConfig') || undefined;

		const breakOnFirstLine: boolean = adapterConfig.get('breakOnFirstLine') || false;
		if (this.log.enabled) this.log.debug(`Using breakOnFirstLine: ${breakOnFirstLine}`);

		return { cwd, configFilePath, env, nodePath, nodeArgv, labPath, labConfig, debuggerPort, debuggerConfig, breakOnFirstLine };
	}

	// private createDecorations(
	// 	event: LabTestEvent,
	// 	testfiles: Map<string, string>
	// ): TestDecoration[] {

	// 	const testfile = testfiles.get(<string>event.test);
	// 	const decorations: TestDecoration[] = [];

	// 	if (testfile && event.failures) {

	// 		if (this.log.enabled) this.log.info(`Adding ${event.failures.length} failure decorations to ${testfile}`);

	// 		for (const failure of event.failures) {
	// 			const decoration = this.createDecoration(failure, testfile);
	// 			if (decoration) {
	// 				decorations.push(decoration);
	// 			}
	// 		}
	// 	}

	// 	return decorations;
	// }

	// private createDecoration(
	// 	failure: LabFailedExpectation,
	// 	testfile: string
	// ): TestDecoration | undefined {

	// 	if (this.log.enabled) this.log.debug(`Trying to parse stack trace: ${JSON.stringify(failure.stack)}`);

	// 	const error: Error = { name: '', message: '', stack: failure.stack };
	// 	const stackFrames = parseStackTrace(error);

	// 	for (const stackFrame of stackFrames) {
	// 		if (stackFrame.getFileName() === testfile) {
	// 			return {
	// 				line: stackFrame.getLineNumber() - 1,
	// 				message: failure.message
	// 			}
	// 		}
	// 	}

	// 	this.log.debug('No matching stack frame found');
	// 	return undefined;
	// }
}

interface LoadedConfig {
	cwd: string;
	configFilePath: string;
	env: { [prop: string]: any };
	nodePath: string | undefined;
	nodeArgv: string[];
	labPath: string;
	labConfig: any;
	debuggerPort: number;
	debuggerConfig: string | undefined;
	breakOnFirstLine: boolean;
}

interface LabFailedExpectation {
	stack: string;
	message: string;
}

export interface LabTestEvent extends TestEvent {
	failures?: LabFailedExpectation[] | undefined
}
