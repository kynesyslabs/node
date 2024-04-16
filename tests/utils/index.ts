import { IPayOptions } from "sdk/localsdk/multichain/types/transfers"

/**
 * Verify that keys in a list of items appear in ascending order
 * @param items The list of items
 * @param key The key to compare
 * @returns True if the list is sorted, false otherwise
 */
export function verifyNumberOrder(items: any[], key: string) {
	// INFO: Verify that each number is greater than the previous one
	return items.every((num, i) => {
		const current = Number(num[key])
		const prev = Number(items[i - 1]?.[key])
		return i === 0 || current > prev
	})
}

/**
 * Generate a list of transaction params for testing
 * @param address The address to send the transactions to
 * @returns A list of transaction params ready to be passed to preparePays
 */
export function getSampleTranfers(address: string, length: number = 10): IPayOptions[] {
	return Array.from({ length }, (_, i) => {
		return {
			address,
			// INFO: Amount is passed to preparePays as a string
			amount: `${i + 1}`,
		}
	})
}
