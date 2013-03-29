(function(factory){
	if(typeof define != "undefined"){ // AMD
		define(["heya-logger/test", "heya-logger/transports/raw",
			"heya-logger/transports/short", "heya-logger/transports/console",
			"heya-logger/transports/exception", "heya-unify"], factory);
	}else if(typeof module != "undefined"){ // node.js
		module.exports = factory(require("heya-logger/test"),
			require("heya-logger/transports/raw"),
			require("heya-logger/transports/short"),
			require("heya-logger/transports/console"),
			require("heya-logger/transports/exception"),
			require("heya-unify"));
	}
})(function(logger, rawTransport, shortTransport, consoleTransport, exceptionTransport, unify){
	"use strict";

	var raw = rawTransport(50);

	// defaults

	var DEFAULT_ASYNC_TIMEOUT = 15000,	// in ms
		DEFAULT_TEST_DELAY    = 20;		// in ms, only for browsers

	// container of tests

	var batches = [
		// each element is a triplet:
		// module
		// tests --- an array of tests
	];

	// Each test can be a function or a hash like this:
	// name --- an optional name (otherwise it is a function name)
	// test --- a named test function

	// our custom logger to show test messages

	var output = logger.getLogger();
	output.filter = 0;
	output.transports = [{
		log: shortTransport
	}];

	// our custom tester/logger

	var tester = logger.getLogger();
	tester.filter = 0;
	tester.transports = [
		{
			filter: [0, 200],
			log: shortTransport
		},
		{
			filter: 200,
			log: consoleTransport
		},
		{
			log: raw.log
		},
		{
			log: function(logger, meta, text, condition, custom){
				if(!tester.expectedLogs && meta.level >= 200){ // test, assert, error
					stats.failure = true;
				}
			}
		},
		{
			filter: 300,
			log: exceptionTransport
		}
	];
	// change default names
	logger._addCond(tester, 200, "test", "t");
	logger._addCond(tester, 300, "assert", "t");

	tester.batchIndex = 0;
	tester.testIndex = 0;
	tester.inFlight = 0;
	tester.flyingTests = {};

	// support for asynchronous operations

	function FlightTicket(name, tester, batchIndex, testIndex){
		tester.flyingTests[name] = 1;
		++tester.inFlight;

		this.name = name;
		this.tester = tester;
		this.batchIndex = batchIndex;
		this.testIndex = testIndex;
	}

	FlightTicket.prototype = {
		declaredClass: "logger/unit/FlightTicket",
		onTime: function(){
			return this.batchIndex === this.tester.batchIndex &&
				this.testIndex === this.tester.testIndex;
		},
		done: function(){
			if(this.onTime()){
				// decrement the counter
				delete this.tester.flyingTests[this.name];
				if(!--this.tester.inFlight){
					// if we are the last, inform the tester
					this.tester.done();
				}
				return;
			}
			// late operation
			var test = batches[this.batchIndex].tests[this.testIndex],
				testName = (typeof test == "function" ? test.name : test.name || test.test.name) ||
					"anonymous";
			tester.warn("Asynchronous operation has finished late: " + this.name +
				" " + tester.getTestName(),
				{
					moduleId:  batches[this.batchIndex].module.id,
					fileName:  batches[this.batchIndex].module.filename,
					testName:  testName,
					asyncName: this.name
				}
			);
		}
	};

	tester.startAsync = function startAsync(name){
		return new FlightTicket(name, this, this.batchIndex, this.testIndex);
	};

	tester.getTestName = function getTestName(){
		var testName = "";
		if(this.batchIndex >= batches.length){ return ""; }
		var batch = batches[this.batchIndex],
			id = (batch.module.mid || batch.module.id || ""),
			filename = batch.module.filename || batch.module.uri || batch.module.url || "";
		if(this.testIndex >= batch.tests.length){ return ""; }
		var test = batch.tests[this.testIndex], name;
		if(typeof test == "function"){
			name = test.name;
		}else if(test){
			name = test.name || test.test.name;
		}
		name = name || "anonymous";
		id += " : " + name;
		return (filename ? "in " + filename + " " : "") + (id ? "as " + id : "");
	};

	tester.done = function(){
		if(tester.timeout){
			clearTimeout(tester.timeout);
			tester.timeout = null;
		}
		if(tester.expectedLogs){
			if(!stats.failure){
				if(!unify(raw.getQueue(), tester.expectedLogs)){
					output.error("Unexpected log sequence " + tester.getTestName());
					stats.failure = true;
				}
			}
			tester.expectedLogs = null;
			raw.clearQueue();
		}
		tester.flyingTests = {};
		if(stats.failure){
			++stats.failedTests;
		}
		++tester.testIndex;
		run();
	}

	// statistics

	var stats = {
			totalTests: 0,
			failedTests: 0,
			failure: false
		};

	// runners

	function waitForAsync(timeout){
		tester.timeout = setTimeout(function(){
			clearTimeout(tester.timeout);
			tester.timeout = null;
			if(tester.inFlight){
				var test = batches[tester.batchIndex].tests[tester.testIndex],
					testName = (typeof test == "function" ? test.name : test.name || test.test.name) ||
						"anonymous";
				tester.warn("Unfinished asynchronous tests: " +
					Object.keys(tester.flyingTests).join(", ") +
					" " + tester.getTestName(), {
						moduleId:   batches[tester.batchIndex].module.id,
						fileName:   batches[tester.batchIndex].module.filename,
						testName:   testName,
						asyncNames: tester.flyingTests
					});
				stats.failure = !tester.expectedLogs;
			}
			tester.inFlight = 0;
			tester.flyingTests = {};
			if(tester.expectedLogs){
				if(!stats.failure){
					if(!unify(raw.getQueue(), tester.expectedLogs)){
						output.error("Unexpected log sequence " + tester.getTestName());
						stats.failure = true;
					}
				}
				tester.expectedLogs = null;
				raw.clearQueue();
			}
			if(stats.failure){
				++stats.failedTests;
			}
			++tester.testIndex;
			run();
		}, timeout);
	}

	function finishTests(){
		if(stats.failedTests){
			output.error("Failed " + stats.failedTests + " out of " + stats.totalTests + " tests.");
		}else{
			output.info("Successfully finished " + stats.totalTests + " tests.");
		}
		if(typeof process != "undefined"){
			process.exit(stats.failedTests ? 1 : 0);
		}else if(typeof window != "undefined" && window){
			if(typeof window.callPhantom != "undefined"){
				window.callPhantom(stats.failedTests ? "failure" : "success");
			}
		}
	}

	function runTest(){
		var test, timeout, name, f;
		// open loop
		loop: {
			for(; tester.batchIndex < batches.length; ++tester.batchIndex, tester.testIndex = 0){
				var batch = batches[tester.batchIndex];
				for(; tester.testIndex < batch.tests.length; ++tester.testIndex){
					test = batch.tests[tester.testIndex];
					break loop;
				}
			}
			finishTests();
			return false;
		}
		// the loop's actual body
		tester.meta.id = (batch.module.mid || batch.module.id || "");
		tester.meta.filename = batch.module.filename || batch.module.uri || batch.module.url || "";
		if(typeof test == "function"){
			f = test;
			name = f.name;
			tester.expectedLogs = null;
		}else if(test){
			f = test.test;
			name = test.name || f.name;
			timeout = test.timeout;
			tester.expectedLogs = test.logs;
		}
		timeout = timeout || DEFAULT_ASYNC_TIMEOUT;
		name = name || "anonymous";
		tester.meta.id += " : " + name;
		if(f){
			try{
				if(tester.expectedLogs){
					// turn off console-based transports
					tester.transports[0].filter = tester.transports[1].filter = [0, 0];
				}else{
					// turn on console-based transports as normal
					tester.transports[0].filter = [0, 200];
					tester.transports[1].filter = 200;
				}
				++stats.totalTests;
				stats.failure = false;
				raw.clearQueue();
				f(tester);
			}catch(error){
				if(!tester.expectedLogs){
					stats.failure = true;
					output.error(error);
				}
			}
			if(tester.inFlight){
				waitForAsync(timeout);
				return false;
			}
			if(tester.expectedLogs){
				if(!stats.failure){
					if(!unify(raw.getQueue(), tester.expectedLogs)){
						output.error("Unexpected log sequence " + tester.getTestName());
						stats.failure = true;
					}
				}
				tester.expectedLogs = null;
				raw.clearQueue();
			}
			if(stats.failure){
				++stats.failedTests;
			}
			tester.flyingTests = {};
		}
		// advance the loop
		++tester.testIndex;
		return true;
	}

	function runOnCli(){
		while(runTest());
	}

	function runOnBrowser(){
		if(runTest()){
			var h = setTimeout(function(){
				clearTimeout(h);
				runOnBrowser();
			}, DEFAULT_TEST_DELAY);
		}
	}

	var run = typeof process != "undefined" ? runOnCli : runOnBrowser;

	// update the default logger

	logger.filter = 200;
	logger.transports = [
		{
			filter: [0, 200],
			log: shortTransport
		},
		{
			filter: 200,
			log: consoleTransport
		},
		{
			log: raw.log
		},
		{
			log: function(logger, meta, text, condition, custom){
				if(!tester.expectedLogs && meta.level >= 200){ // test, assert, error
					stats.failure = true;
				}
			}
		},
		{
			filter: 300,
			log: exceptionTransport
		}
	];

	// user interface

	function add(module, tests){
		batches.push({module: module, tests: tests});
	}

	return {
		add: add,
		run: run
	};
});
