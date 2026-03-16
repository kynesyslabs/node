declare module "ffjavascript" {
    export const Scalar: any
    export const utils: {
        unstringifyBigInts: (o: any) => any
        stringifyBigInts: (o: any) => any
        [key: string]: any
    }
    export function getCurveFromName(name: string, singleThread?: boolean): Promise<any>
}
