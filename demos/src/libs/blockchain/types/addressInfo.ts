import { StatusNative } from "src/model/entities/StatusNative"
import { StatusProperties } from "src/model/entities/StatusProperties"

export default interface AddressInfo {
    native: StatusNative | null
    properties: StatusProperties | null
}
