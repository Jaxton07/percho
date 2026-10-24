import { type EnvironmentRef, LOCAL_ENVIRONMENT } from "@percho/shared";
import { createContext, useContext } from "react";

/** A mounted settings subtree captures a target; this is never a global execution switch. */
export const EnvironmentContext = createContext<EnvironmentRef>(LOCAL_ENVIRONMENT);
export function useEnvironment(): EnvironmentRef {
	return useContext(EnvironmentContext);
}
