// import { LabTestEvent } from '../adapter';
import { CustomReporter } from "./customReporter";
import { format } from 'util';
import { TestEvent } from "vscode-test-adapter-api";

const sendMessage = process.send ? (message: any) => process.send!(message) : () => {};

export = class RunTestsReporter implements CustomReporter {

	constructor(_options: any) { }

	start(notebook: any): void {
		sendMessage(`Running ${notebook.count} tests`);
	}

	testStart(test: any): void {
		const ev: TestEvent = {
			type: 'test',
			test: `${test.location?.file}#${test.location?.line}`,
			state: 'running',
			// file: test.location.file,
			// line: test.location.line,
			// testRunId: test.id
		};

		sendMessage(ev);
	}

	test(test: any): void {
		const ev: TestEvent = {
			type: 'test',
			test: `${test.location?.file}#${test.location?.line}`,
			state: 'passed',
			description: `${test.duration}ms`,
			// file: test.location.file,
			// line: test.location.line,
			// testRunId: test.id
		};

		if (test.todo) ev.state = 'errored';
		else if (test.skipped) ev.state = 'skipped';
		else if (test.err) ev.state = 'failed';

		if (test.err) sendMessage(format(test.err));
		sendMessage(ev);
	}
	end(notebook: any): void {
		sendMessage(`Run ${notebook.tests.count} tests in ${notebook.ms}ms. Failures: ${notebook.failures}`);
	}

// 	specStarted(result: jasmine.CustomReporterResult): void {

// 		if ((this.testsToReport === undefined) ||
// 			(this.testsToReport.indexOf(result.fullName) >= 0)) {

// 			const event: LabTestEvent = {
// 				type: 'test',
// 				test: result.fullName,
// 				state: 'running'
// 			};
	
// 			this.sendMessage(event);
// 		}
// 	}

// 	specDone(result: jasmine.CustomReporterResult): void {

// 		if ((this.testsToReport === undefined) ||
// 			(this.testsToReport.indexOf(result.fullName) >= 0)) {
// 			let message: string | undefined;
// 			if (result.failedExpectations) {
// 				message = result.failedExpectations.map(failed => failed.stack).join('\n');
// 			}

// 			const state = convertTestState(result.status);
// 			const event: LabTestEvent = {
// 				type: 'test',
// 				test: result.fullName,
// 				state: convertTestState(result.status),
// 				message,
// 			}
// 			if ((state === 'failed') && result.failedExpectations) {
// 				event.failures = result.failedExpectations.map(
// 					failure => ({ stack: failure.stack, message: failure.message })
// 				);
// 			}

// 			this.sendMessage(event);
// 		}
// 	}
// }

// function convertTestState(jasmineState: string | undefined): 'passed' | 'failed' | 'skipped' {

// 	switch (jasmineState) {

// 		case 'passed':
// 		case 'failed':
// 			return jasmineState;

// 		case 'pending': // skipped in the source (e.g. using xit() instead of it())
// 		case 'excluded': // skipped due to test run filter
// 		default:
// 			return 'skipped';
// 	}
}
