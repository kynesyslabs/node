import * as forever from "forever-monitor"
// LINK https://github.com/foreversd/forever-monitor

// Starting and monitoring the server
var child = forever.start([ "yarn", "server" ], {
    max : 10, // 10 times is the maximum number of tries
    silent : false, // We want the output of course
    killTree: true, // All the children will be killed (anakin)
    minUptime: 10000, // If running for less than 10 seconds, it will be killed
})