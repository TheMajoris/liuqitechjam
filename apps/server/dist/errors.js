export class HttpError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
        this.name = "HttpError";
    }
}
export class RunCancelledError extends Error {
    constructor() {
        super("Run cancelled");
        this.name = "RunCancelledError";
    }
}
