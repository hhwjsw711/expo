// twilio is only installed/used in production (dynamic `await import("twilio")`
// inside phoneAuth.ts / twilioVerify.ts). This ambient declaration satisfies
// the type checker in dev environments where the package is absent.
declare module 'twilio' {
  const Twilio: any;
  export default Twilio;
}
