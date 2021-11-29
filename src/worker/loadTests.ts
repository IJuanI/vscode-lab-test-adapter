import * as util from 'util';
import * as Path from 'path';
import rewire from 'rewire';
import { TestInfo, TestSuiteInfo } from 'vscode-test-adapter-api';
import { patchLabCli, spyLab, stopSpy } from './patchLab';

function convertTests(tests: any[]): TestInfo[] {
	const onlyMode = tests.some(test => test.options.only);
	return tests.map(test => convertTest(test, onlyMode));
}

function convertTest(test: any, onlyMode: boolean): TestInfo {
	let label = test.relativeTitle;
	if (label?.length > 32)
		label = test.relativeTitle.substr(0, 32) + '..';

	return {
		type: 'test',
		id: `${test.location?.file}#${test.location?.line}`,
		label,
		skipped: test.options.skip || (onlyMode && !test.options.only),
		debuggable: true,
		file: test.location?.file,
		line: test.location?.line
	}
}

function convertExperiment(experiment: any): TestSuiteInfo {
	const children: (TestSuiteInfo | TestInfo)[] = [];
	children.push(...experiment.experiments.map((ex: any) => convertExperiment(ex)));
	children.push(...convertTests(experiment.tests));

	return {
		type: 'suite',
		id: `${experiment.location?.file}#${experiment.location?.line}`,
		label: experiment.title,
		debuggable: true,
		children,
		file: experiment.location?.file,
		line: experiment.location?.line
	}
}

let logEnabled = false;
try {
	const labPath = process.argv[2];
	logEnabled = <boolean>JSON.parse(process.argv[4]);
	
	const Lab = rewire(Path.join(labPath, '../cli'));
	let clock;
	
	if (logEnabled) clock = process.hrtime();
	let labConfig = require(process.argv[3]);
	labConfig = patchLabCli(Lab, labConfig);
	labConfig.lint = false; // Not yet supported
	labConfig.coverage = false; // Not yet supported
	if (logEnabled) {
		clock = process.hrtime(clock);
		process.send!(`load config: ${(clock[0] + clock[1] / 1000000000).toFixed(4)}s`);
	}
	
	const suites: (TestSuiteInfo | TestInfo)[] = [];
	
	if (logEnabled) clock = process.hrtime();
	if (logEnabled) process.send!('setting up spies');
	spyLab(labPath); // Inspect test locations
	if (logEnabled) process.send!('running traverse');
	const scripts = Lab.__get__('internals.traverse')(labConfig.paths, labConfig);
	if (logEnabled) process.send!('removing spies');
	stopSpy(labPath);
	if (logEnabled) {
		clock = process.hrtime(clock);
		process.send!(`scan tests: ${(clock[0] + clock[1] / 1000000000).toFixed(4)}s`);
	}
	
	if (logEnabled) clock = process.hrtime();
	scripts.map((suite: any) => {
		suites.push(...suite._current.experiments
			.map((experiment: any) => convertExperiment(experiment)));
			suites.push(...convertTests(suite._current.tests));
	});
	if (logEnabled) {
		clock = process.hrtime(clock);
		process.send!(`analyze tests: ${(clock[0] + clock[1] / 1000000000).toFixed(4)}s`);
	}

	process.send!(suites);

} catch (err) {
	if (logEnabled) process.send!(`Caught error ${util.inspect(err)}`);
	throw err;
}
