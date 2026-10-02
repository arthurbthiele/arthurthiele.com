export function ignoreLinksToCurrentPage() {
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest("a");
    if (link == null || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const destination = new URL(link.href, window.location.href);
    const isCurrentPage = destination.origin === window.location.origin && destination.pathname === window.location.pathname;
    if (isCurrentPage && destination.hash === "") event.preventDefault();
  });
}
