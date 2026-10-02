// jsdom has no viewport layout to scroll.
window.scrollTo = () => undefined;
HTMLElement.prototype.scrollIntoView = () => undefined;
window.matchMedia = (media: string): MediaQueryList => ({
  matches: false,
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return true;
  },
});
