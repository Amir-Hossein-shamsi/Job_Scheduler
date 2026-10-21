"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { gsap } from "gsap";

export function Animated({
  children,
  className = "",
  animationKey = "",
}: {
  children: ReactNode;
  className?: string;
  animationKey?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const media = gsap.matchMedia(ref);
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(
        "[data-animate]",
        { y: 16, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.55,
          stagger: 0.065,
          ease: "power3.out",
          clearProps: "all",
        },
      );
    });
    return () => media.revert();
  }, [animationKey]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
