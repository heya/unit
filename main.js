/* UMD.define */ (typeof define=="function"&&define||function(d,f,m){m={module:module,require:require};module.exports=f.apply(null,d.map(function(n){return m[n]||require(n)}))})
(["heya-ice/test", "heya-ice/sinks/raw", "heya-ice/sinks/exception",
	"heya-unify", "heya-unify/utils/preprocess"],
function(ice, rawSink, exceptionSink, unify, preprocess){
	"use strict";

	// defaults

	var DEFAULT_ASYNC_TIMEOUT = 15000,	// in ms
		DEFAULT_TEST_DELAY    = 20;		// in ms, only for browsers

	// container of tests

	var batches = [
		// each element is a pair:
		// module
		// tests --- an array of tests
	];

	// Each test can be a function or a hash like this:
	// name --- an optional name (otherwise it is a function name)
	// test --- a named test function

	// statistics

	var stats = {
			// global stats
			totalTests:   0,
			failedTests:  0,
			totalChecks:  0,
			failedChecks: 0,
			totalAborted: 0,
			// local stats (per test)
			localTests:   0,
			localFails:   0,
			aborted:      false,
			// methods
			newTest: function(){
				++this.totalTests;
				this.localTests = this.localFails = 0;
				this.aborted = false;
			},
			endTest: function(){
				if(this.localFails || this.aborted){
					++this.failedTests;
					this.failedChecks += this.localFails;
					if(this.aborted){
						++this.totalAborted;
					}
				}
			},
			clear: function(){
				this.totalTests = this.failedTests =
				this.totalChecks= this.failedChecks =
				this.totalAborted = 0;
				this.newTest();
			}
		};

	// count assert() and test() calls
	// (we don't use dcl here to reduce external references)

	function addCounter(ice, name){
		var proto = ice.Ice.prototype, old = proto[name];
		proto[name] = function(){
			++stats.totalChecks;
			++stats.localTests;
			return old.apply(this, arguments);
		};
	}
	addCounter(ice, "test");
	addCounter(ice, "TEST");
	addCounter(ice, "assert");
	addCounter(ice, "ASSERT");

	// prepare transports

	var raw = rawSink(50);

	function shortSink(ice, meta, text, condition, custom){
		console.log(meta.name + ": " + (text || condition || "-") +
			(meta.filename ? " in " + meta.filename : "") +
			(meta.filename && meta.id && meta.filename != meta.id ? " as " + meta.id : "") +
			(meta.level >= 200 && meta.level <= 300 ?
				" @ test/assert #" + stats.localTests : "")
		);
	}

	function consoleSink(ice, meta, text, condition, custom){
		console.log(meta.name + ": " + meta.level + " on " +
			meta.time.toUTCString() + " in " + meta.filename +
			(meta.filename !== meta.id ? " as " + meta.id : "") +
			(meta.level >= 200 && meta.level <= 300 ?
				" @ test/assert #" + stats.localTests : "")
		);
		if(text){
			console.log(meta.name + ": text - " + text);
		}
		if(condition){
			console.log(meta.name + ": cond - " + condition);
		}
		if(meta.stack){
			console.log(meta.name + ": stack");
			console.log(meta.stack);
			console.log(meta.name + ": end of stack");
		}
		if(custom){
			console.log(meta.name + ": custom - ", custom);
		}
	};

	var silentTransport = [
			{
				log: raw.log
			},
			{
				log: function(ice, meta, text, condition, custom){
					if(!tester.expectedLogs && meta.level >= 200 && meta.level <= 300){ // test, assert
						++stats.localFails;
					}
				}
			},
			{
				filter: 300,
				log: exceptionSink
			}
		],
		normalTransport = [
			{
				filter: [0, 200],
				log: shortSink
			},
			{
				filter: 200,
				log: consoleSink
			}
		];
	normalTransport = normalTransport.concat(silentTransport);

	// update the default ice

	ice.filter = 200;
	ice.setNamedTransports("default", normalTransport);

	// our custom ice to show test messages

	var output = ice.specialize();
	output.filter = 0;
	output.setNamedTransports("output", [{log: shortSink}]);
	output.transport = "output";

	// our custom tester/ice

	var tester = ice.specialize();
	tester.selfName = "t";
	tester.filter = 0;

	tester.unify = unify;

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
		declaredClass: "ice/unit/FlightTicket",
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
			output.error("Asynchronous operation has finished late: " + this.name);
		}
	};

	tester.startAsync = function startAsync(name){
		return new FlightTicket(name, this, this.batchIndex, this.testIndex);
	};

	tester.getTestName = function getTestName(noLocalTests){
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
		if(!noLocalTests){
			id += " @ test/assert #" + stats.localTests;
		}
		return (filename ? "in " + filename + " " : "") + (id ? "as " + id : "");
	};

	tester.done = function(){
		if(tester.timeout){
			clearTimeout(tester.timeout);
			tester.timeout = null;
		}
		if(tester.expectedLogs){
			if(!stats.localFails && !stats.aborted){
				if(!unify(raw.getQueue(), preprocess(tester.expectedLogs, true))){
					++stats.localTests;
					++stats.localFails;
					output.error("Unexpected log sequence " + tester.getTestName(true));
					printRawLogs();
				}
			}
			tester.expectedLogs = null;
			raw.clearQueue();
		}
		tester.flyingTests = {};
		stats.endTest();
		++tester.testIndex;
		run();
	}

	// runners

	function waitForAsync(timeout){
		tester.timeout = setTimeout(function(){
			clearTimeout(tester.timeout);
			tester.timeout = null;
			if(tester.inFlight){
				if(!tester.expectedLogs){
					++stats.localTests;
					++stats.localFails;
				}
				try{
					tester.error("Unfinished asynchronous tests: " +
						Object.keys(tester.flyingTests).join(", "));
				}catch(e){
					// suppress this error (it is inside of a timeout)
				}
			}
			tester.inFlight = 0;
			tester.flyingTests = {};
			if(tester.expectedLogs){
				if(!stats.localFails && !stats.aborted){
					if(!unify(raw.getQueue(), preprocess(tester.expectedLogs, true))){
						++stats.localTests;
						++stats.localFails;
						output.error("Unexpected log sequence " + tester.getTestName(true));
						printRawLogs();
					}
				}
				tester.expectedLogs = null;
				raw.clearQueue();
			}
			stats.endTest();
			++tester.testIndex;
			run();
		}, timeout);
	}

	function finishTests(){
		if(stats.failedTests){
			output.error("FAILURE: " + stats.failedTests + "/" + stats.totalTests +
				" test functions" +
				(stats.totalAborted ? " (aborted: " + stats.totalAborted + ")" : "") +
				" with " + stats.failedChecks + "/" + stats.totalChecks + " individual tests");
		}else{
			output.info("SUCCESS: " + stats.totalTests + " test functions, " +
				stats.totalChecks + " individual tests");
		}
		if(typeof process != "undefined"){
			process.exit(stats.failedTests ? 1 : 0);
		}else if(typeof window != "undefined" && window){
			if(typeof window.callPhantom != "undefined"){
				window.callPhantom(stats.failedTests ? "failure" : "success");
			}
		}
		batches = [];
		stats.clear();
	}

	function printRawLogs(){
		var logs = raw.getQueue();
		output.info("Got " + logs.length + " record" +
			(logs.length != 11 && logs.length % 10 == 1 ? "" : "s") + ":");
		for(var i = 0; i < logs.length; ++i){
			var log = logs[i];
			output.info(log.meta.name + ": " + (log.text || log.condition || "-") +
				(log.meta.filename ? " in " + log.meta.filename : "") +
				(log.meta.filename && log.meta.id && log.meta.filename != log.meta.id ?
					" as " + log.meta.id : ""));
		}
		output.info("=====");
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
					tester.setNamedTransports("default", silentTransport);
				}else{
					// turn on console-based transports as normal
					tester.setNamedTransports("default", normalTransport);
				}
				stats.newTest();
				raw.clearQueue();
				f(tester);
			}catch(error){
				try{
					tester.error(error);
				}catch(e){
					// suppress
				}
				if(!tester.expectedLogs){
					stats.aborted = true;
				}
			}
			if(tester.inFlight){
				waitForAsync(timeout);
				return false;
			}
			if(tester.expectedLogs){
				if(!stats.localFails && !stats.aborted){
					if(!unify(raw.getQueue(), preprocess(tester.expectedLogs, true))){
						++stats.localTests;
						++stats.localFails;
						output.error("Unexpected log sequence " + tester.getTestName(true));
						printRawLogs();
					}
				}
				tester.expectedLogs = null;
				raw.clearQueue();
			}
			stats.endTest();
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

	// user interface

	function add(module, tests){
		batches.push({module: module, tests: tests});
	}

	return {
		add: add,
		run: run
	};
});
