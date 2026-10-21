// Les appels HTTP vers l'IdP, et la différence entre « l'IdP refuse » et « l'IdP ne répond pas » :
// la première révoque l'accès, la seconde ne doit jamais déconnecter qui que ce soit.
const IDP_TIMEOUT_MS = 10_000;

/** L'IdP est injoignable, trop lent ou en erreur (5xx) : réessayer plus tard. */
export class IdpUnavailableError extends Error {}

/** L'IdP refuse explicitement le refresh token (invalid_grant) : compte bloqué, accès révoqué. */
export class IdpRejectedError extends Error {}

/** fetch borné dans le temps ; réseau, délai dépassé ou 5xx deviennent IdpUnavailableError. */
export async function fetchFromIdp(url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(IDP_TIMEOUT_MS) });
  } catch (error) {
    throw new IdpUnavailableError(`IdP injoignable (${(error as Error).message})`, { cause: error });
  }
  if (response.status >= 500) throw new IdpUnavailableError(`IdP en erreur (${response.status})`);
  return response;
}

/** Lit un refus du token_endpoint : invalid_grant devient IdpRejectedError, le reste une erreur simple. */
export async function readTokenRefusal(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (body.error === 'invalid_grant') return new IdpRejectedError(`l'IdP refuse le jeton (invalid_grant)`);
  return new Error(`jeton refusé par l'IdP (${response.status}${body.error ? ` ${body.error}` : ''})`);
}
