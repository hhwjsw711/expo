import React from 'react';
import { ScrollViewStyleReset } from 'expo-router/html';

export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: iPhoneFrameStyles }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const iPhoneFrameStyles = `
html, body {
  height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  background-color: #111111 !important;
  overflow: hidden !important;
}

#root {
  display: flex !important;
  height: 100% !important;
  align-items: center !important;
  justify-content: center !important;
  background-color: #111111 !important;
}
`;
