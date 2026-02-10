import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { AlertCircle, Home } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50">
      <Card className="w-full max-w-md mx-4 shadow-lg">
        <CardContent className="pt-6 pb-2 flex flex-col items-center">
          <div className="bg-red-100 p-4 rounded-full mb-4">
            <AlertCircle className="h-10 w-10 text-red-500" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2 text-center">Page Not Found</h1>
          <p className="text-sm text-gray-600 text-center">
            The page you are looking for doesn't exist or might have been moved.
          </p>
        </CardContent>
        <CardFooter className="flex justify-center pt-2 pb-6">
          <Link href="/">
            <Button className="flex items-center gap-2">
              <Home className="h-4 w-4" />
              Back to Home
            </Button>
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}