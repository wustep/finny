import { createFileRoute } from "@tanstack/react-router";
import { Separator } from "@/components/ui/separator";

export const Route = createFileRoute("/policy")({
  component: PolicyPage,
});

const EFFECTIVE_DATE = "August 12, 2026";

function PolicyPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Policies</h1>
        <p className="text-sm text-muted-foreground">
          Effective {EFFECTIVE_DATE} · Finny is a personal, invite-only
          service. Questions: wujstephen@gmail.com
        </p>
        <ul className="mt-3 list-disc pl-5 text-sm">
          <li>
            <a href="#privacy" className="underline underline-offset-4">
              Privacy Policy
            </a>
          </li>
          <li>
            <a href="#retention" className="underline underline-offset-4">
              Data Retention and Disposal Policy
            </a>
          </li>
        </ul>
      </div>

      <section id="privacy" className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Privacy Policy
        </h2>

        <PolicyHeading>What Finny does</PolicyHeading>
        <P>
          Finny syncs financial data from your linked bank accounts (via
          Plaid) into databases in your own Notion workspace. It is a
          pass-through service: financial data flows from Plaid to Notion and
          is not stored by Finny.
        </P>

        <PolicyHeading>Information we store</PolicyHeading>
        <List
          items={[
            "Your Google account basics from sign-in: name, email address, and profile photo.",
            "Plaid access tokens for the bank connections you link, plus connection metadata: institution name, account names, last-4 masks, and account types.",
            "Your Notion workspace connection (OAuth token), the page you chose as the sync destination, and the IDs of the databases Finny created.",
            "Sync bookkeeping: cursors, run timestamps and counts, and an opaque mapping between provider record IDs and Notion page IDs. These identifiers contain no amounts, merchants, dates, or balances.",
            "The IP address of access-password attempts, kept for rate limiting and abuse prevention.",
          ]}
        />

        <PolicyHeading>Information we do not store</PolicyHeading>
        <List
          items={[
            "Transactions, balances, holdings, and any other financial figures. They pass through Finny's sync process in memory and are written only to your Notion workspace, where you control them.",
            "Bank credentials. You authenticate directly with your bank through Plaid; Finny never sees usernames, passwords, or MFA codes, and its Plaid access is read-only.",
          ]}
        />

        <PolicyHeading>Service providers</PolicyHeading>
        <List
          items={[
            "Plaid (bank connectivity) — receives your bank authorization; see Plaid's End User Privacy Policy.",
            "Notion (sync destination) — receives the financial data you chose to sync, into your own workspace.",
            "Convex (backend hosting) — stores the configuration data listed above, encrypted at rest.",
            "Vercel (web hosting) and Google (sign-in).",
          ]}
        />

        <PolicyHeading>What we don't do</PolicyHeading>
        <List
          items={[
            "No selling or sharing of data with third parties beyond the providers above.",
            "No advertising, no trackers, no analytics scripts.",
            "No access to your data by anyone other than you, except as required to operate or debug the service (server logs may contain record identifiers and error messages, never financial figures).",
          ]}
        />

        <PolicyHeading>Access control</PolicyHeading>
        <P>
          Every account requires the shared access password and Google
          sign-in. Actions that read bank data or write to Notion are
          additionally authorized server-side per user; each user can only
          ever reach their own connections and their own Notion workspace.
        </P>
      </section>

      <Separator />

      <section id="retention" className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Data Retention and Disposal Policy
        </h2>

        <PolicyHeading>Retention while your account is active</PolicyHeading>
        <List
          items={[
            "Connection tokens and configuration are retained for as long as the related connection exists, since they are required to operate the sync.",
            "Sync run logs (timestamps, trigger, row counts, error messages) are retained for operational debugging. They contain no financial data.",
            "Opaque record-ID mappings are retained while syncing is active so that updates modify existing Notion rows instead of creating duplicates.",
            "Access-attempt records (IP, failure count) are retained until reviewed; banned entries persist until manually cleared.",
          ]}
        />

        <PolicyHeading>Disposal on your actions</PolicyHeading>
        <List
          items={[
            "Removing a bank connection immediately deletes its Plaid access token and account metadata from Finny, and revokes the connection at Plaid (item removal), which instructs Plaid to stop data access. Settings has a “Disconnect everything” action that does this for every connection at once; if Plaid rejects one of the revocations, Finny still deletes its own copy of that token and tells you which connection to check.",
            "Disconnecting Notion immediately deletes the stored Notion token and the record of which databases Finny created. Notion's API has no token-revocation endpoint, so this removes Finny's copy of the token; you can additionally remove the Finny integration from your Notion workspace's connection settings. Data already synced to your Notion workspace is yours and remains there; Finny never deletes it.",
            "Data synced to Notion can be deleted by you at any time in Notion; Finny will not recreate rows for records it no longer syncs.",
          ]}
        />

        <PolicyHeading>Account deletion</PolicyHeading>
        <P>
          You can delete your account yourself, at any time, from Settings.
          Deletion revokes every bank connection at Plaid and then erases all
          associated records — user profile, Plaid and Notion tokens,
          connection and destination configuration, the opaque record-ID map,
          sync run logs, and sign-in sessions. It runs immediately and cannot
          be undone. Email wujstephen@gmail.com if you would rather it be done
          for you; that route is completed within 30 days.
        </P>
        <List
          items={[
            "Data already synced to your Notion workspace is not deleted — it is yours, in your workspace. Because the record-ID map is erased with the account, a future account syncing to the same page creates every row again rather than updating it, so clear the old databases first if you want to avoid duplicates.",
            "Access-attempt records are keyed by IP address rather than by account and are retained for abuse prevention, as described above.",
            "Residual copies in encrypted infrastructure backups expire on the backup provider's rotation schedule.",
          ]}
        />

        <PolicyHeading>Disposal method</PolicyHeading>
        <P>
          All records live in a managed database (Convex); disposal is
          performed by deleting the records, after which they are
          unrecoverable by the application. No financial data exists to
          dispose of, by design: the system's only copy of your financial
          data is the one in your own Notion workspace.
        </P>
      </section>
    </div>
  );
}

function PolicyHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-2 font-medium">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm leading-6 text-muted-foreground">{children}</p>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-6 text-muted-foreground">
      {items.map((item) => (
        <li key={item.slice(0, 40)}>{item}</li>
      ))}
    </ul>
  );
}
