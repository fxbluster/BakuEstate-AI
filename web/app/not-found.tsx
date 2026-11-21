import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";

export default function NotFound() {
  return (
    <div className="exec-card mx-auto my-12 max-w-md p-8 text-center space-y-4">
      <SearchX className="mx-auto h-10 w-10 text-gold-400" />
      <h1 className="text-lg font-bold text-slate-100">Səhifə və ya elan tapılmadı</h1>
      <p className="text-xs text-slate-400">
        Axtardığınız elan bazada mövcud deyil və ya silinmiş ola bilər.
      </p>
      <Link href="/" className="exec-btn-primary text-xs">
        <ArrowLeft className="h-3.5 w-3.5" />
        <span>İcmala qayıt</span>
      </Link>
    </div>
  );
}
