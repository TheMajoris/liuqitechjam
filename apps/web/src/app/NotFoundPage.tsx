import { Link } from "react-router-dom";
import { PageHeader } from "../shared/ui/PageHeader";

export function NotFoundPage() {
  return (
    <div className="page">
      <PageHeader
        title="Page not found"
        lead="That route is not part of the control plane."
      />
      <p>
        <Link to="/projects" className="text-link">
          Return to Projects
        </Link>
      </p>
    </div>
  );
}
