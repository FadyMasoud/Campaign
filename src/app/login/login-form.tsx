'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { signInWithGoogle, signInWithPassword, type LoginState } from '@/lib/auth/actions'
import styles from './login.module.css'

/**
 * The only Client Component on this screen, and only because it needs two
 * things the server cannot give it: the pending state of a submission, and an
 * error rendered without losing what the user typed.
 *
 * The credentials themselves are never handled here — the form posts to a
 * Server Action, which is what lets the session be written as HttpOnly
 * cookies. This component never sees a token.
 */

const INITIAL: LoginState = { error: null }

function SubmitButton() {
  // useFormStatus reads the state of the nearest enclosing form, which is why
  // this is a child component rather than inline: called in the same component
  // as the <form>, it always reports false.
  const { pending } = useFormStatus()

  return (
    <button type="submit" className={styles.submit} disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  )
}

function GoogleButton() {
  const { pending } = useFormStatus()

  return (
    <button type="submit" className={styles.google} disabled={pending}>
      <svg className={styles.googleMark} viewBox="0 0 18 18" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
        />
        <path
          fill="#34A853"
          d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
        />
        <path
          fill="#FBBC05"
          d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
        />
        <path
          fill="#EA4335"
          d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
        />
      </svg>
      {pending ? 'Redirecting…' : 'Continue with Google'}
    </button>
  )
}

/**
 * Google can fail in ways that are not faults, and saying "try again" to
 * someone whose account simply does not exist sends them round in circles.
 */
const GOOGLE_ERRORS: Record<string, string> = {
  signup_disabled:
    'That Google account is not set up for this portal. Accounts here are created by an administrator rather than by signing in, so signing in again will not help — ask to have your account added.',
  access_denied:
    'Google sign-in was cancelled. Nothing has changed; you can try again or use your email and password.',
  google:
    'Google sign-in did not complete. Try again, or use your email and password below.',
}

export function LoginForm({ next, errorCode }: { next: string; errorCode?: string }) {
  const [state, formAction] = useActionState(signInWithPassword, INITIAL)
  const googleMessage = errorCode ? GOOGLE_ERRORS[errorCode] ?? GOOGLE_ERRORS.google : null

  return (
    <div className={styles.forms}>
      {googleMessage ? (
        <p className={styles.error} role="alert">
          {googleMessage}
        </p>
      ) : null}

      <form action={formAction} className={styles.form} noValidate>
        {/* Carried through the sign-in so the user resumes where they were
            headed. Validated server-side — it is user input like any other. */}
        <input type="hidden" name="next" value={next} />

        <div className={styles.field}>
          <label htmlFor="email" className={styles.label}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className={styles.input}
            placeholder="owner@kilele.vg-eval.test"
            aria-describedby={state.error ? 'login-error' : undefined}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="password" className={styles.label}>
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={styles.input}
            aria-describedby={state.error ? 'login-error' : undefined}
          />
        </div>

        {state.error ? (
          <p id="login-error" className={styles.error} role="alert">
            {state.error}
          </p>
        ) : null}

        <SubmitButton />
      </form>

      <div className={styles.divider}>
        <span className={styles.dividerText}>or</span>
      </div>

      <form action={signInWithGoogle} className={styles.form}>
        <input type="hidden" name="next" value={next} />
        <GoogleButton />
      </form>
    </div>
  )
}
