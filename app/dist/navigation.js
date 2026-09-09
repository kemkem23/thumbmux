/** Browser navigation for a single-page shell, backed by one query parameter. */
export function createQueryParamNav(param = 'session') {
    const subscribers = new Set();
    let current = readSession();
    let disposed = false;
    function readSession() {
        const value = new URL(window.location.href).searchParams.get(param);
        return value && value.trim() ? value.trim() : null;
    }
    function publish() {
        for (const subscriber of [...subscribers])
            subscriber(current);
    }
    function replaceSession(name) {
        const url = new URL(window.location.href);
        if (name)
            url.searchParams.set(param, name);
        else
            url.searchParams.delete(param);
        window.history.replaceState(null, '', url);
        current = readSession();
        publish();
    }
    const onPopState = () => {
        if (disposed)
            return;
        current = readSession();
        publish();
    };
    window.addEventListener('popstate', onPopState);
    return {
        get session() {
            return current;
        },
        subscribe(run) {
            run(current);
            if (disposed)
                return () => { };
            subscribers.add(run);
            let active = true;
            return () => {
                if (!active)
                    return;
                active = false;
                subscribers.delete(run);
            };
        },
        openSession(name) {
            replaceSession(name);
        },
        showHub() {
            replaceSession(null);
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            window.removeEventListener('popstate', onPopState);
            subscribers.clear();
        },
    };
}
