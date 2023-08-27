// INFO Method mimicking solidity require() method
/* NOTE 
 * Usage: you can use required(your_required_value) to throw an error if your_required_value is not true
 * This can include both boolean values and any other value that you want to check against negative
 * statements, like 'null' or 'undefined'.
 * 
 * You can specify a message to be returned if the required value is not true.
 * You can also set fatal to false to avoid throwing an error if the required value is not true.
*/

export interface requiredOutcome {
	success: boolean;
	message?: string;
}

export default function required(value: any, 
    msg: string = "Missing required element", fatal: boolean = true): requiredOutcome {
    if (!value) {
        if (fatal) throw new Error("[REQUIRED] " + msg)
        return {success: false, message: msg}
    }
    return {success: true, message: ""}
}