import "./globals.css";

export const metadata = {
  title: "PressPlay Today — Where the News Becomes a Game",
  description: "Discover the stories capturing attention. Play them.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div className="nav"><div className="wrap"><span className="brand">Press<span>Play</span> Today</span></div></div>
        {children}
      </body>
    </html>
  );
}
