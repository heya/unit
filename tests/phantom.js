function onError(errMsg){
	return function(msg, trace){
		var msgStack = [errMsg + ": " + msg];
		if(trace){
			msgStack.push("TRACE:");
			trace.forEach(function(t){
				msgStack.push(" -> " + (t.file || t.sourceURL) + ": " + t.line +
					(t.function ? " (in function " + t.function + ")" : ""));
			});
		}
		console.error(msgStack.join('\n'));
		phantom.exit(1);
	};
}

phantom.onError = onError("PHANTOM ERROR");

var page = require("webpage").create();

page.onError = onError("ERROR");

page.onAlert = function(msg){
	console.log("ALERT: " + msg);
};

page.onConsoleMessage = function(msg){
	console.log(msg);
};

page.onCallback = function(msg){
	switch(msg){
		case "success":
			phantom.exit(0);
			break;
		case "failure":
			phantom.exit(1);
			break;
	}
}

var scriptPath = require("system").args[0],
	path = require("fs").absolute(
		(scriptPath.length && scriptPath.charAt(0) == "/" ? "" : "./") + scriptPath).split("/");

path.pop();
path.push("tests.html");

page.open(path.join("/"), function(status){
	if(status !== "success"){
		console.error("ERROR: Can't load a web page.");
		phantom.exit(1);
	}
});
