import { get as getStackTrace } from 'stack-trace';
import mock, { stop } from 'mock-require';
import Path from 'path';

export interface Location {
	file: string
	line: number
}

export function patchLabCli(labCli: any, labConfig: any): any {

	// Fill base configuration with defaults
	labCli.__set__({'internals.rc': labConfig});
	process.argv = []; // Lab cli interprets argv as overrides for testing paths
	labConfig = labCli.__get__('internals.options')();

	return labConfig;
}

export function patchRunner(labRunner: any) {

	// Inform reporter when a test starts executing
	const origProtect = labRunner.__get__('internals.protect');
	labRunner.__set__({
		['internals.protect']: function() {
			if (arguments[0].location)
				arguments[1].reporter?.testStart?.(arguments[0]);
			return origProtect.apply(this, arguments);
		}
	});
}

export function spyLab(labPath: string): void {

	const lab = require(labPath);

	const originalScript = lab.script;
	lab.script = function () {
		const script = originalScript(this, arguments);

		// monkey patch the suite and test functions to detect the locations from which they were called
		for (const functionName of ['experiment', 'describe', 'suite', 'test', 'it']) {

			let newFuncs: any;
			for (const options of ['', 'skip', 'only']) {
				const origImpl = options ? script[functionName][options] : script[functionName];

				let wrap;
				if (['test', 'it'].includes(functionName)) {
					wrap = function(this: any) {
						const location = findCallLocation();
						const result = origImpl.apply(this, arguments);
						script._current.tests[script._current.tests.length-1].location = location;
						return result;
					};
				} else {
					wrap = function(this: any) {
						const location = findCallLocation();
						let fnIdx = typeof arguments[1] === 'function' ? 1 : 2;
						const origFn = arguments[fnIdx];
						arguments[fnIdx] = function () {
							script._current.location = location;
							return origFn?.apply(this, arguments);
						}
						return origImpl.apply(this, arguments);
					};
				}

				if (options)
					newFuncs[options] = wrap;
				else
					newFuncs = wrap;
			}

			script[functionName] = newFuncs;
		}
		return script;
	};

	mock(labPath, lab);
}

export function stopSpy(labPath: string): void {
	stop(labPath);
}

function findCallLocation(): Location | undefined {

	const stackTrace = getStackTrace();

	for (var i = 0; i < stackTrace.length - 1; i++) {
		if (stackTrace[i].getFileName()?.startsWith(process.cwd())) {
			const callSite = stackTrace[i];
			return {
				file: Path.relative(process.cwd(), callSite.getFileName()),
				line: callSite.getLineNumber()-1 // Test runner uses 0 idx lines
			};
		}
	}

	return undefined;
}
