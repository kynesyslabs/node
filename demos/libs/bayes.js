var bayes = require("bayes")
var fs = require("fs")

class Classifier {
    constructor() {
        this.instance = bayes()
    }

    async learn(text, category) {
        await this.instance.learn(text, category)
    }

    async categorize(text) {
        return this.instance.categorize(text)
    }

    async learn_batch(path) {
        if (!fs.existsSync(path)) {
            throw new Error("File not found: " + path)
        }
        const lines = fs.readFileSync(path, "utf8").split("\n")
        for (const line of lines) {
            // Separate category and text
            const [text, category] = line.split("|")
            await this.learn(text, category)
        }
        return true
    }

    state() {
        return this.instance.toJson()
    }

    load(stateJson) {
        this.instance = bayes.fromJson(stateJson)
    }
}

module.exports = Classifier

async function test() {
    // main code
    const classifier = new Classifier()
    await classifier.learn("hello", "introduction")
    await classifier.learn("goodbye", "end_of_conversation")
    console.log("Actual classifier state:")
    console.log(JSON.stringify(JSON.parse(classifier.state()), null, 2))
    let message = "Hello there!"
    console.log("Predicted category for '" + message + "' is:")
    let classification = await classifier.categorize(message)
    console.log(classification)
    if (classification === "introduction") {
        console.log("General Kenobi!")
    } else if (classification === "end_of_conversation") {
        console.log("Goodbye!")
    }
}

async function test_file() {
    const file = "../tests/bayes_learning_table.txt"
    const classifier = new Classifier()
    await classifier.learn_batch(file)
    console.log("Actual classifier state:")
    console.log(JSON.stringify(JSON.parse(classifier.state()), null, 2))
    let message = "Hello there!"
    console.log("Predicted category for '" + message + "' is:")
    let classification = await classifier.categorize(message)
    console.log(classification)
    if (classification === "introduction") {
        console.log("General Kenobi!")
    } else if (classification === "end_conversation") {
        console.log("Goodbye!")
    }
}

if (require.main === module) {
    test_file()
}
