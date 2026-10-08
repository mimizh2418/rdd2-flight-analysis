import { useEffect, useState } from 'react';

interface Job {
  id: string;
  state: string;
  scenario: string;
  error?: string;
}

/**
 * Connect the optional loopback simulation service and import completed job bundles.
 *
 * @param props Component properties.
 * @param props.load Callback receiving a completed job's Arrow file or legacy CSV bundle as local File objects.
 * @returns React service controls with connection, scenario, job status, cancellation, and result-import actions.
 * @remarks Polling starts after connection and stops on cleanup; request failures appear in the panel.
 */
export function SimulationPanel({ load }: { load: (files: File[]) => void }) {
  const [base, setBase] = useState('http://127.0.0.1:8765');
  const [scenarios, setScenarios] = useState<string[]>([]);
  const [scenario, setScenario] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);

  /**
   * Fetch a service endpoint and surface unsuccessful responses as descriptive errors.
   *
   * @param path API path appended to the enclosing service base URL.
   * @param options Optional standard fetch request options; defaults to a GET request.
   * @returns Promise of an OK Response whose body has not yet been consumed.
   * @throws Error via rejection for an unsuccessful HTTP response, using its response body; network errors also
   *   propagate.
   */
  const request = async (path: string, options?: RequestInit) => {
    const r = await fetch(base + path, options);

    if (!r.ok) {
      throw new Error(await r.text());
    }

    return r;
  };

  /**
   * Discover available scenarios and enable job polling after a successful connection.
   *
   * @returns Promise resolving after updating scenario/connection state or displaying a handled request error.
   * @remarks Selects the first listed scenario by default and starts polling through the connection effect.
   */
  const connect = async () => {
    try {
      setError('');

      const data = await (await request('/api/scenarios')).json();

      setScenarios(data.scenarios);
      setScenario(data.scenarios[0] ?? '');
      setConnected(true);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    if (!connected) {
      return;
    }

    let alive = true;

    /**
     * Refresh job status while this connection is still mounted and active.
     *
     * @returns Promise resolving after a handled poll; successful data updates jobs and failures update the error
     *   message only while the enclosing alive flag remains true.
     */
    const poll = async () => {
      try {
        const data = await (await request('/api/jobs')).json();

        if (alive) {
          setJobs(data.jobs);
        }
      } catch (e) {
        if (alive) {
          setError(String(e));
        }
      }
    };

    void poll();

    const id = setInterval(poll, 2000);

    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [connected, base]);

  /**
   * Submit the selected scenario to the service's simulation queue.
   *
   * @returns Promise resolving after submission or displaying a handled request error. Job details are refreshed by
   *   the polling loop.
   */
  const start = async () => {
    try {
      await request('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });
    } catch (e) {
      setError(String(e));
    }
  };

  /**
   * Fetch a completed job's Arrow file (or legacy CSV bundle), then pass the files to the standard importer.
   *
   * @param id Completed service job ID used in the API URL.
   * @returns Promise resolving after invoking load or displaying a handled fetch error; does not wait for the parent
   *   importer to finish.
   */
  const open = async (id: string) => {
    try {
      const arrow = await fetch(`${base}/api/jobs/${id}/trace.arrow`);
      if (arrow.ok) {
        load([new File([await arrow.blob()], 'trace.arrow')]);
        return;
      }
      // Older services and completed CSV jobs still expose the original two-file bundle.
      if (arrow.status !== 404) throw new Error(await arrow.text());
      const csv = await (await request(`/api/jobs/${id}/trace.csv`)).blob();
      const manifest = await (await request(`/api/jobs/${id}/manifest.json`)).blob();

      load([new File([csv], 'trace.csv'), new File([manifest], 'manifest.json')]);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <details className="sidebar-section">
      <summary>Local simulation service</summary>
      <p className="muted">
        Optional. Launch the Python service with a Modelica checkout and matching Rumoca environment.
      </p>
      <label>
        Service URL
        <input
          value={base}
          onChange={(e) => {
            setBase(e.target.value);
            setConnected(false);
          }}
        />
      </label>
      <button onClick={() => void connect()}>Connect</button>
      {connected && (
        <>
          <label>
            Scenario
            <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {scenarios.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <button disabled={!scenario} onClick={() => void start()}>
            Run simulation
          </button>
          {jobs.map((j) => (
            <div className="job" key={j.id}>
              <span>
                {j.scenario} · {j.state}
              </span>
              {j.error && <p>{j.error}</p>}
              {j.state === 'complete' ? (
                <button onClick={() => void open(j.id)}>Open result</button>
              ) : ['running', 'queued'].includes(j.state) ? (
                <button
                  onClick={() =>
                    void request(`/api/jobs/${j.id}`, { method: 'DELETE' }).catch((e) => setError(String(e)))
                  }
                >
                  Cancel
                </button>
              ) : null}
            </div>
          ))}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
