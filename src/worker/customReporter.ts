export interface CustomReporter {
	start(notebook: any): void;
	testStart?(test: any): void;
	test(test: any): void;
	end(notebook: any): void;
}