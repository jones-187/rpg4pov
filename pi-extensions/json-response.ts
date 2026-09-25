interface JsonResponseApi {
  on(event: "before_provider_request", handler: (event: { payload: unknown }) => unknown): void;
}

/** Request JSON decoding only; grants no tools and never touches story files. */
export default function registerJsonResponse(api: JsonResponseApi): void {
  api.on("before_provider_request", ({ payload }) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("JSON response request must be an object");
    }
    return { ...payload, response_format: { type: "json_object" } };
  });
}
