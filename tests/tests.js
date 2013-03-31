(function(factory){
	var deps = ["module", "../main"];
	if(typeof define != "undefined"){ // AMD
		define(deps, factory);
	}else if(typeof module != "undefined"){ // node.js
		factory.apply(null,
			deps.filter(function(_, i){ return i < factory.length; }).
			map(function req(name){
				return name === "require" && require || name === "module" && module || require(name);
			}));
	}
})(function(module, unit){
	"use strict";

	unit.add(module, [
		function test_simple_output(t){
			t.info("Line #1");
			t.warn("Line #2");
			eval(t.test("2 < 5"));
			eval(t.assert("1 < 3"));
		},
		{
			test: function test_matching_logs(t){
				t.info("Line #1");
				t.warn("Line #2");
				eval(t.test("5 < 2"));
				eval(t.assert("3 < 1"));
			},
			logs: [
				{meta: {name: "info"}, text: "Line #1"},
				{meta: {name: "warn"}, text: "Line #2"},
				{meta: {name: "test"}, condition: "5 < 2"},
				{meta: {name: "assert"}, condition: "3 < 1"}
			]
		},
		function test_async_no_timeout(t){
			var f1 = t.startAsync("async1"), f2;
			setTimeout(function(){
				f2 = t.startAsync("async2");
			}, 20);
			setTimeout(function(){
				eval(t.assert("f1.onTime()"));
				eval(t.test("1 < 2"));
				f1.done();
			}, 40);
			setTimeout(function(){
				eval(t.assert("f2"));
				eval(t.assert("f2.onTime()"));
				eval(t.test("1 < 2"));
				f2.done();
			}, 60);
		},
		{
			test: function test_async_with_timeout(t){
				var f1 = t.startAsync("async1"), f2;
				setTimeout(function(){
					f2 = t.startAsync("async2");
				}, 20);
				setTimeout(function(){
					eval(t.assert("!f1.onTime()"));
					//f1.done();
				}, 40);
				setTimeout(function(){
					eval(t.assert("f2"));
					eval(t.assert("!f2.onTime()"));
					//f2.done();
				}, 60);
			},
			timeout: 20,
			logs: [
				{meta: {name: "error"}}
			]
		}
	]);

	unit.run();
});
