// INFO Web2 Endpoints
export default async function Web2Transactions(
	url = "https://apple.com/robots.txt"
	) {
	console.log("[DEMOS] Requesting url: " + url)
	let web2 = await demos.call("web2Request", {
		action: "getUrl",
		httpVerb: "GET",
		url: url,
		headers: "",
	})
	web2 = JSON.parse(web2);
	return web2;
}