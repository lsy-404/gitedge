// jsdom has no viewport layout to scroll.
// jsdom implements <dialog> without showModal()/close().
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.removeAttribute("open");
  this.dispatchEvent(new Event("close"));
};
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
