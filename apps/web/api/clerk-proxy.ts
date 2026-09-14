import { clerkPreviewProxy } from "../server/clerkPreviewProxy";

export default {
  fetch(request: Request) {
    return clerkPreviewProxy(request, process.env);
  },
};
