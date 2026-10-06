import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

import {localServiceUrl} from "../shared/lib/service-config";
import {realpathSync} from "node:fs";
import {configuredServicePorts} from "../server/lib/service-ports";
const ports=configuredServicePorts();
const SERVER_URL=process.env.VITE_API_BASE !== undefined ? localServiceUrl(process.env.VITE_API_BASE,"API proxy") : `http://127.0.0.1:${ports.api}`;
const identity={service:"heed-ui",protocolVersion:1,checkoutRoot:realpathSync(fileURLToPath(new URL("../..",import.meta.url))),pid:process.pid};

export default defineConfig({
	plugins: [react(),{name:"heed-readiness",configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/.well-known/heed-service")return next();res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(identity));});}}],
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
