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

function getWeightedRR(env){
	let sum = 0;
	env.WEIGHTS.forEach(w => {
		sum += w;
	});

	let rnd = getRandomInt(sum - 1);
	for(let i = 0; i < env.WEIGHTS.length; i++){
		if(rnd < env.WEIGHTS[i]) return env.ORIGINS[i];
		rnd -= env.WEIGHTS[i];
	}

	return env.ORIGINS[0];
}

function getRandomOrigin(env){
	let algo = env.BALANCING_ALGO;
	if(algo == 1) return getWeightedRR(env);
	return env.ORIGINS[getRandomInt(env.ORIGINS.length)];
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
		userOrigin = getRandomOrigin(env);
		await env.KV.put(hashedIP, userOrigin, { expirationTtl: 172800 });
		let nres = new Response(userOrigin);
		nres.headers.append('Cache-Control', 's-maxage=60');
		ctx.waitUntil(cache.put(cacheKey, nres));
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

async function changeOrigin(request, env, ctx, hashedIP, userOrigin, params){
	for(let i = 0; i < 5; i++){
		userOrigin = getRandomOrigin(env);
		let req = new Request(userOrigin + "/?" + params, request);
		req.headers.set('Origin', new URL(userOrigin + "/?" + params).origin);
		const responseFB = await fetch(req);
		if(!responseFB.ok || (responseFB.status != 200 && responseFB.status != 429)) continue;
		await fallbackServer(request, env, ctx, hashedIP, userOrigin);
		return responseFB;
	}
	return Response.redirect(userOrigin);
}

export default {
	async fetch(request, env, ctx) {
		let date = new Date().toISOString().split('T')[0];
		let IP = request.headers.get('CF-Connecting-IP');
		let hashedIP = await hash("rabbitcompany" + IP + date, 'SHA-256');
		let userOrigin = await getUserOrigin(request, env, ctx, hashedIP);

		if(request.url.includes('?')){
			let params = request.url.split('?')[1];

			let req = new Request(userOrigin + "/?" + params, request);
			req.headers.set('Origin', new URL(userOrigin + "/?" + params).origin);

			const response = await fetch(req);
			if(!response.ok || (response.status != 200 && response.status != 429)){
				return await changeOrigin(request, env, ctx, hashedIP, userOrigin, params);
			}
			return response;
		}else{
			return Response.redirect(userOrigin);
		}
	}
};
