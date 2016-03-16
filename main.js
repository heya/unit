/* UMD.define */ (typeof define=="function"&&define||function(d,f,m){m={module:module,require:require};module.exports=f.apply(null,d.map(function(n){return m[n]||require(n)}))})
(["heya-ice/test", "heya-ice/sinks/raw", "heya-ice/sinks/exception",
	"heya-unify", "heya-unify/utils/preprocess", "heya-unify/unifiers/matchString"],
function(ice, rawSink, exceptionSink, unify, preprocess, matchString){
	"use strict";

	// defaults

	var DEFAULT_ASYNC_TIMEOUT = 5000,	// in ms
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
				this.totalTests   =
				this.failedTests  =
				this.totalChecks  =
				this.failedChecks =
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
					if(!ice.expectedLogs && meta.level >= 200 && meta.level <= 300){ // test, assert
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

	function FlightTicket(tester, name, count){
		this.tester = tester;
		this.name = name;

		count = Math.max(count || 1, 1);
		if(typeof tester.flyingTests[name] == "number"){
			tester.flyingTests[name] += count;
		}else{
			tester.flyingTests[name] = count;
		}
		tester.inFlight += count;
	}

	FlightTicket.prototype = {
		declaredClass: "heya-unit/FlightTicket",
		onTime: function(){
			return !this.tester.isDone();
		},
		done: function(){
			if(this.tester.isDone()){
				// late operation
				output.error("Asynchronous operation has finished late: " + this.name);
			}else{
				// decrement the counter
				if(this.tester.flyingTests[this.name] > 0){
					--this.tester.flyingTests[this.name];
					if(!--this.tester.inFlight){
						// if we are the last, inform the tester
						this.tester.done();
					}
				}else{
					output.error("Asynchronous operation was marked as 'done' too many times: " + this.name);
				}
			}
		}
	};

	tester.startAsync = function startAsync(name, count){
		return new FlightTicket(this, name, count);
	};

	tester.isDone = function isDone(){
		return this.inFlight == 0;
	};

	tester.getTestName = function getTestName(noLocalTests){
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
		if(this.timeout){
			clearTimeout(this.timeout);
			this.timeout = null;
			if(this.expectedLogs){
				if(!stats.localFails && !stats.aborted){
					if(!unify(raw.getQueue(), preprocess(this.expectedLogs, true))){
						++stats.localTests;
						++stats.localFails;
						output.error("Unexpected log sequence " + this.getTestName(true));
						printRawLogs();
					}
				}
				this.expectedLogs = null;
				raw.clearQueue();
			}
			this.flyingTests = {};
			stats.endTest();
			runTests(this.next());
		}
	}

	tester.wait = function wait(timeout){
		if(this.timeout){
			this.error("Trying to set a timeout for the second time");
			return;
		}
		this.timeout = setTimeout(function(){
			this.timeout = null;
			if(this.inFlight){
				if(!this.expectedLogs){
					++stats.localTests;
					++stats.localFails;
				}
				try{
					this.error("Unfinished asynchronous tests: " +
						Object.keys(this.flyingTests).filter(function(key){
							return this.flyingTests[key] > 0;
						}, this).join(", "));
				}catch(e){
					// suppress this error (it is inside of a timeout)
				}
			}
			this.inFlight = 0;
			if(this.expectedLogs){
				if(!stats.localFails && !stats.aborted){
					if(!unify(raw.getQueue(), preprocess(this.expectedLogs, true))){
						++stats.localTests;
						++stats.localFails;
						output.error("Unexpected log sequence " + this.getTestName(true));
						printRawLogs();
					}
				}
				this.expectedLogs = null;
				raw.clearQueue();
			}
			stats.endTest();
			runTests(this.next());
		}.bind(this), timeout);
	};

	tester.next = function next(){
		var t = makeTester();
		if(!t){
			// finishTests() is called by makeTester()
			return null;
		}
		t.batchIndex = this.batchIndex;
		t.testIndex  = this.testIndex + 1;

		// test new indices
		if(t.batchIndex >= batches.length){
			finishTests();
			return null;
		}
		if(t.testIndex < batches[t.batchIndex].tests.length){
			return t;
		}
		// otherwise: new batch
		++t.batchIndex;
		t.testIndex = 0;
		// test new indices
		if(t.batchIndex >= batches.length){
			finishTests();
			return null;
		}
		if(t.testIndex < batches[t.batchIndex].tests.length){
			return t;
		}
		// no more tests
		finishTests();
		return null;
	};

	tester.run = function runTest(){
		var batch = batches[this.batchIndex], test = batch.tests[this.testIndex], name, timeout, f;

		this.meta.id = (batch.module.mid || batch.module.id || "");
		this.meta.filename = batch.module.filename || batch.module.uri || batch.module.url || "";
		if(typeof test == "function"){
			f = test;
			name = f.name;
			this.expectedLogs = null;
		}else if(test){
			f = test.test;
			name = test.name || f.name;
			timeout = test.timeout;
			this.expectedLogs = processLogs(test.logs);
		}
		timeout = isNaN(timeout) ? DEFAULT_ASYNC_TIMEOUT : Math.max(timeout, 0);
		name = name || "anonymous";
		this.meta.id += " : " + name;
		if(f){
			try{
				if(this.expectedLogs){
					// turn off console-based transports
					this.setNamedTransports("default", silentTransport);
				}else{
					// turn on console-based transports as normal
					this.setNamedTransports("default", normalTransport);
				}
				stats.newTest();
				raw.clearQueue();
				f(this);
			}catch(error){
				try{
					this.error(error);
				}catch(e){
					// suppress
				}
				if(!this.expectedLogs){
					stats.aborted = true;
				}
			}
			if(this.inFlight){
				this.wait(timeout);
				return null;
			}
			if(this.expectedLogs){
				if(!stats.localFails && !stats.aborted){
					if(!unify(raw.getQueue(), preprocess(this.expectedLogs, true))){
						++stats.localTests;
						++stats.localFails;
						output.error("Unexpected log sequence " + this.getTestName(true));
						printRawLogs();
					}
				}
				this.expectedLogs = null;
				raw.clearQueue();
			}
			stats.endTest();
		}
		return this.next();
	};

	function makeTester(){
		if(!batches.length || !batches[0].tests.length){
			finishTests();
			return null;
		}
		var t = Object.create(tester);
		t.flyingTests = {};
		return t;
	}

	function processLogs(logs){
		if(logs instanceof Array &&
		   logs.some(function(record){
			return typeof record == "string" || record instanceof RegExp;
		})
		  ){
			return logs.map(function(record){
				if(typeof record == "string"){
					return {text: record};
				}
				if(record instanceof RegExp){
					return {text: matchString(record)};
				}
				return record;
			});
		}
		return logs;
	}

	// runners

	function runOnNode(test){
		while(test){
			test = test.run();
		}
	}

	function runOnBrowser(test){
		if(test){
			test = test.run();
			if(test){
				setTimeout(function(){
					runTests(test);
				}, DEFAULT_TEST_DELAY);
			}
		}
	}

	var runTests = typeof process != "undefined" ? runOnNode : runOnBrowser;

	// user interface

	function add(module, tests){
		if(tests.length){
			batches.push({module: module, tests: tests});
		}
	}

	function run(){
		runTests(makeTester());
	}

	return {
		add: add,
		run: run
	};
});
