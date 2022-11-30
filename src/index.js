var origins = [
	"https://dev.passky.org",
	"https://dev2.passky.org",
	"https://dev3.passky.org"
];

async function hash(message, encryption) {
	const msgUint8 = new TextEncoder().encode(message);
	const hashBuffer = await crypto.subtle.digest(encryption, msgUint8);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getRandomInt(max, min = 0) {
	min = Math.ceil(min);
	max = Math.floor(max);
	return Math.floor(Math.random() * (max - min)) + min;
}

function getRandomOrigin(){
	return origins[getRandomInt(origins.length)];
}

async function getUserOrigin(request, env, ctx, hashedIP){
	let userOrigin = null;

	let cacheKey = new Request(request.url + "?key=" + hashedIP, { headers: request.headers, method: 'GET' });
	let cache = caches.default;
	let res = await cache.match(cacheKey);
	if(res) userOrigin = await res.text();

	if(userOrigin == null){
		userOrigin = await env.KV.get(hashedIP, { cacheTtl: 3600 });
		let nres = new Response(userOrigin);
		nres.headers.append('Cache-Control', 's-maxage=3600');
		if(userOrigin != null) ctx.waitUntil(cache.put(cacheKey, nres));
	}

	if(userOrigin == null){
		userOrigin = getRandomOrigin();
		await env.KV.put(hashedIP, userOrigin, { expirationTtl: 172800 });
		let nres = new Response(userOrigin);
		nres.headers.append('Cache-Control', 's-maxage=3600');
		ctx.waitUntil(cache.put(cacheKey, nres));
	}

	let isDown = await isServerDown(request, env, ctx, userOrigin);
	if(isDown) await fallbackServer(request, env, ctx, hashedIP);

	return userOrigin;
}

async function fallbackServer(request, env, ctx, hashedIP){
	let fbServer = getRandomOrigin();

	let cacheKey = new Request(request.url + "?key=" + hashedIP, { headers: request.headers, method: 'GET' });
	let cache = caches.default;
	await cache.match(cacheKey);

	let nres = new Response(fbServer);
	nres.headers.append('Cache-Control', 's-maxage=3600');
	ctx.waitUntil(cache.put(cacheKey, nres));

	await env.KV.put(hashedIP, fbServer, { expirationTtl: 172800 });
}

async function isServerDown(request, env, ctx, origin){
	let isDown = false;
	let time = null;

	let cacheKey = new Request(request.url + "?server=" + origin, { headers: request.headers, method: 'GET' });
	let cache = caches.default;
	let res = await cache.match(cacheKey);
	if(res) time = await res.text();

	if(time == null){
		time = await env.KV.get(origin, { cacheTtl: 60 });
		let nres = new Response(origin);
		nres.headers.append('Cache-Control', 's-maxage=60');
		if(time != null) ctx.waitUntil(cache.put(cacheKey, nres));
	}

	if(time != null) isDown = true;

	return isDown;
}

async function serverDown(server, env){
	let date = new Date().toISOString().replace('T', ' ').split('.')[0];;
	let isLogged = await env.KV.get(server, { cacheTtl: 60 });
	if(isLogged == null) await env.KV.put(server, date, { expirationTtl: 864000 });
}

async function serverUp(server, env){
	let isLogged = await env.KV.get(server, { cacheTtl: 60 });
	if(isLogged != null) await env.KV.delete(server);
}

async function checkServer(origin, env){
	await fetch(origin).then((res) => {
		if(!res.ok){
			serverDown(origin, env);
		}else if(res.status != 200){
			serverDown(origin, env);
		}else{
			serverUp(origin, env);
		}
	}).catch(() => {
		serverDown(origin, env);
	});
}

export default {
	async fetch(request, env, ctx) {
		let date = new Date().toISOString().split('T')[0];
		let IP = request.headers.get('CF-Connecting-IP');
		let hashedIP = await hash("rabbitcompany" + IP + date, 'SHA-256');
		let userOrigin = await getUserOrigin(request, env, ctx, hashedIP);

		if(request.url.includes('?')){
			let params = request.url.split('?')[1];
			return fetch(userOrigin + "/?" + params);
		}

		return Response.redirect(userOrigin);
	},
	async scheduled(controller, env, ctx) {
		origins.forEach(origin => {
			ctx.waitUntil(checkServer(origin, env));
		});
	},
};
