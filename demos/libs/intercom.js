const PubSub = require("pubsub-js")

let intercom = {
    broadcast: function (topic, data) {
        PubSub.publishSync(topic, data)
    },
    subscribe: function (topic, callback) {
        let _subscriber = PubSub.subscribe(topic, callback)
        return _subscriber
    },
    unsubscribe: function (subscriber) {
        PubSub.unsubscribe(subscriber)
    },
    test: function () {
        this.broadcast("new_message", "test")
    },
}

module.exports = intercom
