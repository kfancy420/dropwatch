// First-run setup: what it is, how it gets your attention, the first product.

import { useState } from "react";

import type { AppState } from "../../shared/types.js";
import { call } from "./api.js";
import { AddProductForm } from "./forms.js";
import { Button, Lamp, Mark } from "./ui.js";
import { AlertToggles, PhoneSetup, TestAlert } from "./views/Settings.js";

const STEPS = 3;

export function Onboarding({
  state,
  onReminder,
  onBestBuySetup,
}: {
  state: AppState;
  onReminder(url: string, name: string): void;
  onBestBuySetup(): void;
}) {
  const [step, setStep] = useState(0);
  const finish = () => void call("completeOnboarding");

  return (
    <div className="onboard">
      <div className="onboard__card">
        {step === 0 && (
          <div className="onboard__brand">
            <Mark />
            <span>Dropwatch</span>
          </div>
        )}
        <p className="onboard__step">
          Step {step + 1} of {STEPS}
        </p>

        {step === 0 && (
          <>
            <h1>Know the minute it's back in stock</h1>
            <p className="lead">
              Dropwatch keeps an eye on the product pages you choose. When one comes back in stock it opens the
              page, sounds an alarm and can buzz your phone. You do the buying.
            </p>
            <ul className="rows onboard__sample" aria-hidden="true">
              <li className="row row--live">
                <Lamp tone="live" />
                <div className="row__main">
                  <div className="row__name">The booster box you wanted</div>
                  <div className="row__meta">
                    <span>your-favorite-card-shop.com</span>
                    <span>Checked just now</span>
                  </div>
                </div>
                <div className="row__figures">
                  <span className="money">$49.99</span>
                  <span className="status status--live">In stock</span>
                </div>
              </li>
            </ul>
            <p>
              It never buys for you, never skips a queue and never pretends to be a person. It checks politely,
              and only stores that allow it.
            </p>
            <div className="actions actions--start">
              <Button variant="primary" onClick={() => setStep(1)}>
                Set it up
              </Button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1>How should it get your attention?</h1>
            <AlertToggles state={state} />
            <div className="onboard__phone">
              <h2>On your phone</h2>
              <PhoneSetup state={state} />
            </div>
            <TestAlert />
            <div className="actions actions--split">
              <Button variant="quiet" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button variant="primary" onClick={() => setStep(2)}>
                Continue
              </Button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Add the first thing you want</h1>
            <AddProductForm
              onAdded={finish}
              onReminder={(url, name) => {
                finish();
                onReminder(url, name);
              }}
              onBestBuySetup={() => {
                finish();
                onBestBuySetup();
              }}
            />
            <div className="actions actions--split">
              <Button variant="quiet" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button variant="quiet" onClick={finish}>
                Skip for now
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
