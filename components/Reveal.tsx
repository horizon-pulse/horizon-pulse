"use client";
import { useEffect } from "react";

/** Linear-style reveal: only blocks that start below the fold fade up once. No-JS and reduced-motion users see everything. */
export function Reveal() {
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]")).filter(
      (el) => el.getBoundingClientRect().top > window.innerHeight,
    );
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          el.classList.add("rv-in");
          el.classList.remove("rv-hide");
          io.unobserve(el);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    els.forEach((el) => {
      const sibs = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.hasAttribute("data-reveal")) : [];
      el.style.setProperty("--rv-d", `${Math.min(sibs.indexOf(el), 6) * 60}ms`);
      el.classList.add("rv-hide");
      io.observe(el);
    });
    return () => io.disconnect();
  }, []);
  return null;
}
