import { useUser } from "@/hooks/use-user";

export function OperationsFilter({ onFilterChange }) {
  const { user } = useUser();

  // Get user department for color styling
  const getDepartmentColor = () => {
    if (!user?.department) return "bg-white";

    switch (user.department) {
      case "DISPATCH {VALSAD}":
        return "bg-green-100";
      case "DISPATCH {INDORE}":
        return "bg-amber-100";
      case "DISPATCH {LUCKNOW}":
        return "bg-orange-100";
      case "BILLING":
        return "bg-yellow-100";
      default:
        return "bg-purple-100";
    }
  };

  return (
    <div 
      className={`inline-flex items-center gap-2 p-2 shadow rounded-xl transition-colors duration-300 ${getDepartmentColor()}`}
    >
      <span className="text-sm">My Ops</span>
    </div>
  );
}