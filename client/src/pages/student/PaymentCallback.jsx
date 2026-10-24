import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, naira } from '../../api/client.js';
import { Check, Alert } from '../../components/Icons.jsx';
import { Spinner } from '../../components/ui.jsx';

/**
 * Paystack sends the student back here (?reference=...). The server confirms
 * the payment with Paystack before marking it paid.
 */
export default function PaymentCallback() {
  const [params] = useSearchParams();
  const reference = params.get('reference') || params.get('trxref');
  const [state, setState] = useState({ status: 'checking' });

  useEffect(() => {
    if (!reference) {
      setState({ status: 'error', message: 'No payment reference was returned.' });
      return;
    }
    api
      .get(`/payments/verify?reference=${encodeURIComponent(reference)}`)
      .then((d) => setState({ status: d.payment.status, payment: d.payment }))
      .catch((err) => setState({ status: 'error', message: err.message }));
  }, [reference]);

  const back = state.payment ? `/student/stage/${state.payment.stage_id}` : '/student';
  return (
    <div className="mobile-page">
      <div className="topbar">
        <div className="wrap">
          <h1>Payment</h1>
        </div>
      </div>
      <main className="content narrow">
        <div className="card stack center" style={{ alignItems: 'center', padding: 28 }}>
          {state.status === 'checking' && (
            <>
              <Spinner />
              <p className="muted">Confirming your payment with Paystack…</p>
            </>
          )}
          {state.status === 'success' && (
            <>
              <span className="stage-icon approved" style={{ width: 52, height: 52 }}>
                <Check size={26} />
              </span>
              <h2>Payment received</h2>
              <p className="muted" style={{ margin: 0 }}>
                {naira(state.payment.amount)} for {state.payment.description || state.payment.stage_name}.
              </p>
            </>
          )}
          {(state.status === 'unpaid' || state.status === 'failed') && (
            <>
              <span className="stage-icon rejected" style={{ width: 52, height: 52 }}>
                <Alert size={26} />
              </span>
              <h2>{state.status === 'failed' ? 'Payment failed' : 'Payment not completed'}</h2>
              <p className="muted" style={{ margin: 0 }}>No money was taken. You can try again from the stage page.</p>
            </>
          )}
          {state.status === 'error' && (
            <>
              <h2>We could not confirm this payment</h2>
              <p className="muted" style={{ margin: 0 }}>{state.message}</p>
              {reference && <p className="small faint">Reference: {reference}</p>}
            </>
          )}
          {state.status !== 'checking' && (
            <Link to={back} className="btn btn-primary" style={{ marginTop: 8 }}>
              Back to {state.payment ? state.payment.stage_name : 'dashboard'}
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}
