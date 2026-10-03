// Plain advice for drop day. Store rules change; anything dated here says so.

export function Guide() {
  return (
    <>
      <header className="view__head">
        <div>
          <h1>Drop-day guide</h1>
          <p className="view__sub">What Dropwatch does for you, and what gives you the best odds on the day.</p>
        </div>
      </header>

      <article className="prose">
        <section className="panel">
          <h2>What Dropwatch does</h2>
          <p>
            It checks the product pages on your watchlist once or twice a minute. The moment one comes back in
            stock it opens the page, sounds an alarm and can buzz your phone. You press the buy button yourself.
          </p>
          <p>
            That is the part bots are best at and people are worst at: noticing. A small shop can restock at
            three in the afternoon on a Tuesday, and nobody is watching then. Dropwatch is.
          </p>
        </section>

        <section className="panel">
          <h2>What it will not do</h2>
          <p>
            It never buys for you, fills in checkout, skips a waiting room, or pretends to be a person. Stores
            ban those tricks in their terms, and using them can get an order cancelled or an account closed.
            Dropwatch also stays away from any store that says no to automated checks.
          </p>
          <p>
            So it will not beat a checkout bot in a straight race for speed. Where it helps most is restocks at
            smaller shops, and drops that use a queue or an invitation, where speed does not decide who gets
            one.
          </p>
        </section>

        <section className="panel">
          <h2>Before a drop</h2>
          <ul>
            <li>Sign in to the store ahead of time, and save your address and payment there.</li>
            <li>Open the store a few minutes early. Set a reminder here so you do not have to remember.</li>
            <li>Stay in one tab. If the store puts you in a waiting room, wait your turn and do not refresh.</li>
            <li>Know the regular price, and set a price limit on reseller shops so marked-up stock stays quiet.</li>
            <li>Turn on phone alerts in Settings so a restock reaches you away from the computer.</li>
          </ul>
        </section>

        <section className="panel">
          <h2>Store by store</h2>
          <dl>
            <dt>Smaller online card shops</dt>
            <dd>
              This is where Dropwatch works best. Many of them run on Shopify, which Dropwatch can read
              directly. Paste the product link on the watchlist.
            </dd>
            <dt>Pokemon Center</dt>
            <dd>
              Dropwatch will not check it. Big drops go through a waiting room that is reported to hand out
              places at random, so arriving seconds early does not help. Sign in beforehand, open the site
              before the drop, stay in one tab and wait your turn.
            </dd>
            <dt>Best Buy</dt>
            <dd>
              In November 2025 Best Buy was reported to be moving high-demand Pokemon card releases to
              invitations: you ask for an invite on the product page, and if you are picked you get a day to
              buy. Ask for the invite as soon as the page offers it. Dropwatch can watch ordinary Best Buy
              products once you add a key in Settings.
            </dd>
            <dt>Target and Walmart</dt>
            <dd>
              Dropwatch will not check them. Turn on the store's own in-stock alert if the product page offers
              one, ask your local store which day cards are stocked, and at Walmart buy only listings sold and
              shipped by Walmart.
            </dd>
            <dt>GameStop, Costco and Sam's Club</dt>
            <dd>Dropwatch will not check them. Most of their stock is sold in store, so ask locally.</dd>
            <dt>Amazon</dt>
            <dd>
              Dropwatch will not check it. Buy only listings shipped and sold by Amazon; third-party listings
              carry a counterfeit risk.
            </dd>
          </dl>
        </section>
      </article>
    </>
  );
}
