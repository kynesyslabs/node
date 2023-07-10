let intercom = require("../libs/intercom")

let _callback = (msg, data) => {
    console.log("Received message")
    console.log("Topic: " + msg)
    console.log("Data: " + data)
    console.log("End of message")
}

let subscriber = intercom.subscribe("new_message", _callback)

intercom.test()

intercom.unsubscribe(subscriber)
