// Decides whether an element is hidden from a sighted user. Hidden content is left out of
// the snapshot: the user cannot see it, so the assistant must not read it or act on it.

export function isHiddenElement(el: Element): boolean {
  if ((el as HTMLElement).hidden === true) return true;
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(el);
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  return false;
}
