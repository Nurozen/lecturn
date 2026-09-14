import { clerkPreviewProxy } from "../server/clerkPreviewProxy.js";

export default {
  fetch(request: Request) {
    return clerkPreviewProxy(request, process.env);
  },
};
