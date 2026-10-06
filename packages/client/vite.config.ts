import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

import {localServiceUrl} from "../shared/lib/service-config";
import {readFileSync, realpathSync} from "node:fs";
import {configuredServicePorts} from "../server/lib/service-ports";
import {ServiceDiagnostics} from '../server/lib/service-diagnostics';
const ports=configuredServicePorts();
const SERVER_URL=process.env.VITE_API_BASE !== undefined ? localServiceUrl(process.env.VITE_API_BASE,"API proxy") : `http://127.0.0.1:${ports.api}`;
const identity={service:"heed-ui",protocolVersion:1,checkoutRoot:realpathSync(fileURLToPath(new URL("../..",import.meta.url))),pid:process.pid};
const proxyOrigin=new globalThis.URL(SERVER_URL);
const diagnostics=new ServiceDiagnostics({root:identity.checkoutRoot,ports:{...ports,api:Number(proxyOrigin.port||(proxyOrigin.protocol==='https:'?443:80))},apiOrigin:SERVER_URL,env:process.env});

export default defineConfig({
	define: {
		"import.meta.env.VITE_HEED_VERSION": JSON.stringify(readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim()),
	},
	plugins: [react(),{name:"heed-readiness",configureServer(server){server.httpServer?.once('close',()=>diagnostics.dispose());server.middlewares.use(async(req,res,next)=>{
  const url=new globalThis.URL(req.url||'/',`http://127.0.0.1:${ports.ui}`);
  if(url.pathname==='/.well-known/heed-services'){
   if(req.headers.origin&&!([`http://127.0.0.1:${ports.ui}`,`http://localhost:${ports.ui}`].includes(req.headers.origin))){res.statusCode=403;res.end();return;}
   res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(await diagnostics.get(url.searchParams.get('refresh')==='1')));return;
  }
  if(req.url!=="/.well-known/heed-service")return next();res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(identity));
 });}}],
	server: {
		host: "127.0.0.1",
		port: ports.ui,
		strictPort: true,
		proxy: {
			"/api": {
				target: SERVER_URL,
				changeOrigin: true,
				ws: true,
				// Disable buffering so SSE streams flush immediately
				selfHandleResponse: false,
				configure: (proxy) => {
					proxy.on("proxyRes", (proxyRes) => {
						// Force chunked transfer for SSE
						if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
							delete proxyRes.headers["content-length"];
						}
					});
				},
			},
		},
	},
	resolve: {
		alias: {
			"@heed/shared": fileURLToPath(new URL("../shared/types/index.ts", import.meta.url)),
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
