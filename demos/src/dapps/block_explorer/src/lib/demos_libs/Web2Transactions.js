// INFO This module exposes methods to quickly send Web2 requests to the network

import * as skeletons from './utils/skeletons.js'
import demos from '../demos.js'

// INFO Web2 Endpoints
export default async function Web2Transactions (
  action = 'GET',
  url = 'https://icanhazip.com',
  parameters = [],
  requestedParameters = null,
  headers = null,
  minAttestations = 2
) {
  // Generating an empty one and filling it
  const request = skeletons.web2_request
  request.raw.action = action
  request.raw.url = url
  request.raw.parameters = parameters
  request.raw.headers = headers
  request.raw.minAttestations = minAttestations
  // Ensuring content is a known property
  request.attestations = new Map()
  request.hash = ''
  request.signature = ''
  request.result = ''

  console.log('[Web2Transactions] Requesting:')
  console.log(request)

  let web2 = await demos.call('web2Request', request)
  web2 = JSON.parse(web2)
  return web2
}
