import rewire from 'rewire';
import * as util from 'util';
import Path, { join } from 'path';
import { patchLabCli, patchRunner, spyLab, stopSpy } from './patchLab';

const sendMessage = process.send ? (message: any) => process.send!(message) : () => {};

function stripScripts(scripts: any[], testsToRun: string[]): any[] {
	if (testsToRun.length) {
		
	}

	return scripts;
}

let logEnabled = false;
try {

	const argv = process.argv;
	const labPath = argv[2];
	logEnabled = <boolean>JSON.parse(argv[4]);
	const primaries: string[] = JSON.parse(argv[5]);
	const testsToRun: string[] = JSON.parse(argv[6]);

	const Lab = rewire(join(labPath, '../cli'));

	if (logEnabled) sendMessage('Loading Config file');
	let labConfig = require(argv[3]);
	labConfig = patchLabCli(Lab, labConfig);
	labConfig.lint = false; // Not yet supported
	labConfig.coverage = false; // Not yet supported

	if (logEnabled) sendMessage('Scanning test files');
	spyLab(labPath);
	let scripts: any[] = [];
	const traverse = Lab.__get__('internals.traverse');
	if (primaries.length) {
		for (let primary of primaries) {
			primary = primary.split('#')[0]; // Removes line number
			const sepIdx = primary.lastIndexOf(Path.sep);
			const filename = primary.substr(sepIdx+1);
			const folder = primary.substr(0, sepIdx);
	
			labConfig.pattern = new RegExp(filename.replace(/[\^\$\.\*\+\-\?\=\!\:\|\\\/\(\)\[\]\{\}\,]/g, '\\$&'));
			scripts.push(...traverse([folder], labConfig));
		}
	} else {
		// If root, run all tests
		scripts.push(...traverse(labConfig.paths, labConfig));
	}
	stopSpy(labPath);
	
	if (logEnabled) sendMessage('Stripping selected tests');
	scripts = stripScripts(scripts, testsToRun);
	
	if (logEnabled) sendMessage('Starting reporter');
	labConfig.reporter = require.resolve('./runTestsReporter');
	const Runner = rewire(join(labPath, '../runner'));
	patchRunner(Runner); // Add startTest event
	Runner.report(scripts, labConfig);

} catch (err) {
	if (logEnabled) sendMessage(`Caught error ${util.inspect(err)}`);
	throw err;
}
