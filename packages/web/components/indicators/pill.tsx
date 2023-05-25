import React, { FC } from "react";

export const Pill: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="inline-block flex w-16 items-center justify-center rounded-full bg-gradient-positive px-2 py-1 uppercase text-black">
    {children}
  </div>
);
