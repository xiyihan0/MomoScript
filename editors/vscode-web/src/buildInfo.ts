const BUILD_VERSION_PATTERN = /^\d{12}-[0-9a-f]{7}$/;

export const MMT_BUILD_VERSION = import.meta.env.VITE_MMT_BUILD_VERSION;

if (!BUILD_VERSION_PATTERN.test(MMT_BUILD_VERSION)) {
  throw new Error("MomoScript build version is missing or invalid");
}
