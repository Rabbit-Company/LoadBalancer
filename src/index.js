const cache = caches.default;

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
	return ORIGINS[getRandomInt(ORIGINS.length)];
}

async function getUserOrigin(request, env, ctx, hashedIP){
	let userOrigin = null;

	let cacheKey = request.url + "?key=" + hashedIP;
	let res = await cache.match(cacheKey);
	if(res) userOrigin = await res.text();

	if(userOrigin == null){
		userOrigin = await env.KV.get(hashedIP, { cacheTtl: 3600 });
		let nres = new Response(userOrigin);
		nres.headers.append('Cache-Control', 's-maxage=60');
		if(userOrigin != null) ctx.waitUntil(cache.put(cacheKey, nres));
	}

	if(userOrigin == null){
		userOrigin = getRandomOrigin();
		await env.KV.put(hashedIP, userOrigin, { expirationTtl: 172800 });
		let nres = new Response(userOrigin);
		nres.headers.append('Cache-Control', 's-maxage=60');
		ctx.waitUntil(cache.put(cacheKey, nres));
	}

	let isDown = await isServerDown(request, env, ctx, userOrigin);
	if(isDown){
		for(let i = 0; i < 5; i++){
			userOrigin = getRandomOrigin();
			await fallbackServer(request, env, ctx, hashedIP, userOrigin);
			isDown = await isServerDown(request, env, ctx, userOrigin);
			if(!isDown) break;
		}
	}

	return userOrigin;
}

async function fallbackServer(request, env, ctx, hashedIP, fbServer){

	let cacheKey = request.url + "?key=" + hashedIP;
	const res = new Response(fbServer);
	res.headers.append('Cache-Control', 's-maxage=60');
	ctx.waitUntil(cache.put(cacheKey, res));

	await env.KV.put(hashedIP, fbServer, { expirationTtl: 172800 });
}

async function isServerDown(request, env, ctx, origin){
	let isDown = false;
	let time = null;

	let cacheKey = request.url + "?server=" + origin;
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
	let date = new Date().toISOString().replace('T', ' ').split('.')[0];
	let isLogged = await env.KV.get(server, { cacheTtl: 60 });
	if(isLogged == null) await env.KV.put(server, date, { expirationTtl: 864000 });
}

async function serverUp(server, env){
	let isLogged = await env.KV.get(server, { cacheTtl: 60 });
	if(isLogged != null) await env.KV.delete(server);
}

async function checkServer(origin, env, ctx){
	await fetch(origin + ENDPOINT).then((res) => {
		if(!res.ok){
			ctx.waitUntil(serverDown(origin, env));
		}else if(res.status != 200){
			ctx.waitUntil(serverDown(origin, env));
		}else{
			ctx.waitUntil(serverUp(origin, env));
		}
	}).catch(() => {
		ctx.waitUntil(serverDown(origin, env));
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

			request = new Request(userOrigin + "/?" + params, request);
			request.headers.set('Origin', new URL(userOrigin + "/?" + params).origin);

			let response = await fetch(request);
			response = new Response(response.body, response);

			return response;
		}

		return Response.redirect(userOrigin);
	},
	async scheduled(controller, env, ctx) {
		ORIGINS.forEach(origin => {
			ctx.waitUntil(checkServer(origin, env, ctx));
		});
	},
};
