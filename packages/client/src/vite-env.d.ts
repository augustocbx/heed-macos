/// <reference types="vite/client" />

declare module "*.module.css" {
	const classes: { readonly [key: string]: string };
	export default classes;
}

interface ImportMetaEnv {
	readonly VITE_API_BASE?: string;
	readonly VITE_HEED_VERSION?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
