export interface Voice {
	name: string;
	embedding?: number[];
}

export interface VoicesListResponse {
	voices: string[];
}
